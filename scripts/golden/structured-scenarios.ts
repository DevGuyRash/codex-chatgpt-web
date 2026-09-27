import { createHash } from "node:crypto";
import { GoldenAppServer, NativeCompactionTerminalError, type NativeTurn } from "./app-server";
import { largeHistoryWitness, structuredScenarioPrompts, type GoldenWorkload } from "./workloads";
import { DiagnosticError } from "../../src/diagnostics/problems";
import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { isProGeneration } from "../../src/campaign-policy";
import { findNativeFailure } from "./native-process";

type Phase = "reasoning" | "generation" | "tools" | "queue";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
interface PhaseObservation { threadId: string; turnId: string; phase: Phase }

/** Watch before submission so an early phase cannot be lost behind the turn/start acknowledgement. */
async function nativePhase(app: GoldenAppServer, phase: Exclude<Phase, "queue">, threadId: string, signal: AbortSignal, timeoutMs: number): Promise<PhaseObservation> {
  const method = { reasoning: "item/reasoning/summaryTextDelta", generation: "item/agentMessage/delta", tools: "item/started" }[phase];
  const params = await app.rpc.waitFor(method, params => params.threadId === threadId && typeof params.turnId === "string" && (phase === "tools"
    ? object(params.item) && ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(String(params.item.type))
    : typeof params.delta === "string" && params.delta.length > 0), { signal, timeoutMs });
  return { threadId, turnId: params.turnId as string, phase };
}

export function nativeRateLimited(turn: NativeTurn): boolean {
  if (turn.status !== "failed" || !object(turn.error)) return false;
  const info = turn.error.codexErrorInfo;
  return info === "rateLimitExceeded" || object(info) && object(info.responseTooManyFailedAttempts) && info.responseTooManyFailedAttempts.httpStatusCode === 429;
}

export class NativeScenarioFailure extends DiagnosticError {
  readonly nativeFailure: { threadId: string; turns: NativeTurn[] };
  constructor(threadId: string, turns: readonly NativeTurn[]) {
    const turn = turns.at(-1);
    const limited = turn && nativeRateLimited(turn);
    super(limited ? { code: "rate_limit_exceeded", message: "The native task reported an account rate limit; generation admission is suspended", httpStatus: 429, retryable: true, origin: "native" }
      : { code: "native_scenario_failed", message: "The native scenario did not reach its required terminal status", origin: "native" });
    this.nativeFailure = { threadId, turns: [...turns] };
  }
}

/** Cleanup can fail independently; retain the native terminal inside the combined failure. */
export function findNativeScenarioFailure(error: unknown): NativeScenarioFailure | undefined {
  return findNativeFailure(error, (value): value is NativeScenarioFailure => value instanceof NativeScenarioFailure);
}

/** Protocol outcomes only; artifacts, commit, capture, browser settlement and effect checks remain independent. */
export async function runStructuredScenario(options: {
  app: GoldenAppServer; workload: GoldenWorkload; variant: string; signal: AbortSignal; timeoutMs: number;
  imagePath?: string;
  modelSwitch?: { from: ChatGptWebModelRoute; to: ChatGptWebModelRoute };
  observeQueue?(input: { threadId: string; signal: AbortSignal; timeoutMs: number }): Promise<PhaseObservation>;
  checkpoint(input: { threadId: string; turnId: string }): void | Promise<void>;
  beforeGeneration?: (signal: AbortSignal) => Promise<void>;
}) {
  const { app, workload, variant, signal, timeoutMs } = options;
  signal.throwIfAborted();
  const threadId = app.state().threadId;
  if (!threadId || app.state().submission !== "idle") throw new Error("Structured scenarios require an idle owned native thread");
  const prompts = structuredScenarioPrompts(workload), turns: NativeTurn[] = [];
  const completed = (turn: NativeTurn) => {
    if (turn.status !== "completed") throw new NativeScenarioFailure(threadId, turns);
    return turn;
  };
  const start = async (text: string, mode: "plan" | "default" = "default", route?: ChatGptWebModelRoute) => {
    signal.throwIfAborted();
    await options.beforeGeneration?.(signal);
    const turn = await app.startTurn({ text, mode, ...(route ? { route } : {}) });
    await options.checkpoint({ threadId, turnId: turn.id });
    return turn;
  };
  const finish = async (turn: NativeTurn) => {
    const terminal = await app.waitForCompletion(turn.id, { signal, timeoutMs });
    turns.push(terminal); return terminal;
  };
  if (variant === "model-switch") {
    const routes = options.modelSwitch;
    if (!routes || routes.from.slug === routes.to.slug || [routes.from, routes.to].some(route => isProGeneration(route) || route.interactionMode !== "automatic")) throw new Error("Model switching requires two distinct inspected non-Pro automatic routes");
    completed(await finish(await start(prompts.prepare, "default", routes.from)));
    completed(await finish(await start(prompts.continue, "default", routes.to)));
    return { variant, turns, modelSwitch: { from: routes.from.slug, to: routes.to.slug } };
  }
  if (variant === "continued") {
    completed(await finish(await start(prompts.prepare)));
    completed(await finish(await start(prompts.continue)));
    return { variant, turns };
  }
  if (variant === "compaction") {
    const witness = largeHistoryWitness(workload);
    completed(await finish(await start(`${prompts.prepare}\n\nRetain this exact runner-owned fact for the continuation: ${witness}. Do not write files or commit during preparation.`)));
    signal.throwIfAborted();
    await options.beforeGeneration?.(signal);
    const compaction = await app.compact({ signal, timeoutMs }).catch(error => {
      if (error instanceof NativeCompactionTerminalError && error.threadId === threadId) throw new NativeScenarioFailure(threadId, [...turns, error.turn]);
      throw error;
    });
    if (compaction.threadId !== threadId || compaction.turn.status !== "completed" || compaction.turn.id !== compaction.turnId || compaction.turnId === turns[0]!.id) throw new NativeScenarioFailure(threadId, [...turns, compaction.turn]);
    completed(await finish(await start(`${prompts.continue} Also write output/history-witness.txt with the exact fact retained through compaction followed by a newline; do not guess it from repository files.`)));
    return { variant, turns, compaction, historyWitnessSha256: createHash("sha256").update(`${witness}\n`).digest("hex") };
  }
  if (variant === "plan-revise-execute") {
    const planHashes: string[] = [];
    for (const text of [prompts.plan, prompts.revision]) {
      const turn = await start(text, "plan");
      const terminal = completed(await finish(turn));
      const hashes = app.takePlanHashes(terminal);
      if (hashes.length !== 1) throw new DiagnosticError({ code: "native_plan_missing", message: "The completed native Plan turn did not contain exactly one Plan item", origin: "native", evidenceMissing: "The native turn completed without one attributable Plan item; revision and execution were not submitted." });
      planHashes.push(hashes[0]!);
    }
    if (planHashes[0] === planHashes[1]) throw new Error("Plan revision produced no changed plan evidence");
    completed(await finish(await start(prompts.execute)));
    return { variant, turns, planHashes };
  }
  const phaseMatch = /^(steer|stop)-(reasoning|generation|tools|queue)(-image|-continue)?$/.exec(variant);
  const planInterrupt = variant === "plan-stream-interrupt";
  if (!phaseMatch && !planInterrupt) throw new Error(`No structured scenario implementation for ${variant}`);
  const phase = phaseMatch?.[2] as Phase | undefined;
  const withImage = phaseMatch?.[3] === "-image";
  if (withImage && !options.imagePath) throw new Error("Image steering requires its materialized fixture");
  if (phase === "queue" && !options.observeQueue) throw new Error("Queued scenarios require correlated production browser-admission evidence");
  const observer = new AbortController(), observedSignal = AbortSignal.any([signal, observer.signal]);
  const observation = planInterrupt
    ? app.rpc.waitFor("item/plan/delta", params => params.threadId === threadId && typeof params.turnId === "string" && typeof params.delta === "string" && params.delta.length > 0, { signal: observedSignal, timeoutMs }).then(params => ({ threadId, turnId: params.turnId as string, phase: "generation" as const }))
    : phase === "queue" ? options.observeQueue!({ threadId, signal: observedSignal, timeoutMs }) : nativePhase(app, phase!, threadId, observedSignal, timeoutMs);
  void observation.catch(() => {});
  try {
    const turn = await start(planInterrupt ? prompts.plan : workload.prompt, planInterrupt ? "plan" : "default");
    const terminal = finish(turn);
    void terminal.catch(() => {});
    const observed = await Promise.race([observation, terminal.then(turn => { completed(turn); throw new Error("Native turn settled before the scenario phase could be exercised"); })]);
    if (observed.threadId !== threadId || observed.turnId !== turn.id || observed.phase !== (phase ?? "generation")) throw new Error("Scenario phase evidence belongs to a different task, turn or phase");
    if (phaseMatch?.[1] === "steer") {
      await app.steer(turn.id, { text: prompts.steer, ...(withImage ? { images: [options.imagePath!] } : {}) });
      completed(await terminal);
      return { variant, turns, observation: observed, steeringWitness: prompts.witness };
    }
    await app.interrupt(turn.id);
    if ((await terminal).status !== "interrupted") throw new NativeScenarioFailure(threadId, turns);
    completed(await finish(await start(workload.prompt)));
    return { variant, turns, observation: observed };
  } finally { observer.abort(); }
}
