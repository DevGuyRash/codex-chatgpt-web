import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GoldenAppServer } from "./app-server";
import { NativeExecFailure, runNativeExec } from "./exec";
import { runStructuredScenario } from "./structured-scenarios";
import { GOLDEN_UNICODE_WITNESS, largeHistoryWitness, structuredScenarioPrompts, type GoldenWorkload } from "./workloads";
import { ownedProcessIdentity, type OwnedProcess } from "./workspace";
import type { ProgressPhase } from "./progress";
import { runTuiScenario } from "./tui-scenarios";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export interface NativeScenarioCheckpoint { native: OwnedProcess; threadId?: string; turnId?: string }
export function ownedNativeActivity(frame: { direction: string; message: ObjectValue }, owner: { threadId?: string; turnId?: string }) {
  const params = object(frame.message.params) ? frame.message.params : undefined;
  const item = params && object(params.item) ? params.item : undefined;
  const method = frame.direction === "received" ? frame.message.method : undefined;
  const owned = typeof params?.threadId === "string" && params.threadId === owner.threadId
    && typeof params?.turnId === "string" && params.turnId === owner.turnId;
  const tool = Boolean(owned && method === "item/completed" && item
    && ["commandExecution", "fileChange", "mcpToolCall"].includes(String(item.type)));
  const phase: ProgressPhase | undefined = !owned ? undefined
    : tool || method === "item/commandExecution/outputDelta" && typeof params?.delta === "string" && params.delta.length > 0 ? "tools"
    : method === "item/reasoning/summaryTextDelta" && typeof params?.delta === "string" && params.delta.length > 0 ? "reasoning"
    : ["item/agentMessage/delta", "item/plan/delta"].includes(String(method)) && typeof params?.delta === "string" && params.delta.length > 0 ? "generation" : undefined;
  return { tool, phase };
}
export const finiteNativeScenarios = {
  fresh: 1, formats: 1, unicode: 1, "tool-image": 1, "large-history": 2, continued: 2, resumed: 2, "archived-history": 2, "model-switch": 2, "plan-revise-execute": 3, "plan-stream-interrupt": 2, "plan-tui-execute": 2,
  "steer-reasoning": 2, "steer-generation": 2, "steer-tools": 2,
  "stop-reasoning-continue": 2, "stop-generation-continue": 2, "stop-tools-continue": 2,
} as const;
export type FiniteNativeScenario = keyof typeof finiteNativeScenarios;

/** Native execution only. Runtime, workload/commit checks and final evidence acceptance stay with their owners. */
export async function runNativeScenario(options: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; route: ChatGptWebModelRoute; workload: GoldenWorkload;
  variant: string; signal: AbortSignal; timeoutMs: number; modelProvider?: string; resumeId?: string; imagePath?: string;
  modelSwitch?: { from: ChatGptWebModelRoute; to: ChatGptWebModelRoute };
  onRecord(category: "prompt" | "transport", text: string, progress?: ProgressPhase, receivedAtMs?: number): Promise<unknown>;
  checkpoint(input: NativeScenarioCheckpoint): void | Promise<void>;
  observeQueue?: Parameters<typeof runStructuredScenario>[0]["observeQueue"];
}) {
  options.signal.throwIfAborted();
  if (!["fresh", "formats", "unicode", "tool-image", "large-history", "continued", "resumed", "archived-history", "model-switch", "plan-revise-execute", "plan-stream-interrupt", "plan-tui-execute"].includes(options.variant) && !/^(?:steer|stop)-(?:reasoning|generation|tools|queue)(?:-image|-continue)?$/.test(options.variant)) throw new Error(`No native scenario implementation for ${options.variant}`);
  if (["formats", "tool-image"].includes(options.variant) && options.workload.formatCoverage !== "all") throw new Error("Format and native image coverage require the full shared fixture set at every workload level");
  if (options.resumeId && options.variant !== "resumed") throw new Error("Resume requires the exact prior native task and its declared scenario");
  if (options.variant === "model-switch" && (!options.modelSwitch || options.modelSwitch.to.slug !== options.route.slug)) throw new Error("Model-switch continuation must target the cell's requested route");
  if (options.variant === "plan-tui-execute") return runTuiScenario(options);
  let native: OwnedProcess | undefined, toolItems = 0;
  let attachedImageSha256: string | undefined;
  if (options.variant === "tool-image") {
    const expectedPath = join(options.cwd, "input/label.png");
    if (options.imagePath !== expectedPath || !options.workload.binaryFiles["input/label.png"]) throw new Error("Native image scenario requires its exact materialized fixture");
    const stat = lstatSync(expectedPath);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(expectedPath) !== expectedPath) throw new Error("Native image fixture is not an ordinary owned file");
    const bytes = readFileSync(expectedPath);
    if (!bytes.equals(Buffer.from(options.workload.binaryFiles["input/label.png"]))) throw new Error("Native image fixture differs from the generated workload");
    attachedImageSha256 = createHash("sha256").update(bytes).digest("hex");
  }
  const checkpoint = async (turn: { threadId?: string; turnId?: string } = {}) => {
    if (!native) throw new Error("Native scenario process ownership is unavailable");
    await options.checkpoint({ native, ...turn });
  };
  if (options.variant === "fresh" || options.variant === "formats" || options.variant === "unicode" || options.variant === "tool-image" || options.variant === "large-history" || options.variant === "resumed" || options.variant === "archived-history") {
    const execute = async (prompt: string, resumeId?: string, phase: "preparation" | "execution" = "execution") => {
      const outcome = await runNativeExec({ ...options, resumeId, artifactRepository: options.cwd, prompt,
      ...(attachedImageSha256 ? { images: [options.imagePath!] } : {}),
      onInput: text => options.onRecord("prompt", text).then(() => {}),
      onLaunch: async identity => { native = identity; await checkpoint(); },
      onEvent: async (event, receivedAtMs) => {
        const item = object(event.item) ? event.item : undefined;
        const tool = event.type === "item.completed" && item && ["command_execution", "file_change", "mcp_tool_call"].includes(String(item.type));
        if (tool) toolItems++;
        await options.onRecord("transport", JSON.stringify(event), tool ? "tools" : undefined, receivedAtMs);
        if (event.type === "thread.started" && typeof event.thread_id === "string") await checkpoint({ threadId: event.thread_id });
      },
      onStderr: text => options.onRecord("transport", text).then(() => {}),
      });
      if (outcome.status !== "completed") throw new NativeExecFailure(outcome, phase);
      return outcome;
    };
    let preparation: Awaited<ReturnType<typeof execute>> | undefined;
    let resumeId = options.resumeId;
    const prompts = structuredScenarioPrompts(options.workload);
    if (["resumed", "archived-history", "large-history"].includes(options.variant) && !resumeId) {
      const historyWitness = largeHistoryWitness(options.workload);
      const historyNotes = Array.from({ length: 160 }, (_, index) =>
        `Context note ${index + 1}: ${createHash("sha256").update(`${options.workload.id}:${index}`).digest("hex")} is background material for this same task; preserve the earlier witness without copying these notes into an artifact.`).join("\n");
      const preparationPrompt = options.variant === "large-history"
        ? `${prompts.prepare}\n\nRetain this exact private-to-the-turn fact for the continuation: ${historyWitness}. Do not write files or commit during preparation.\n${historyNotes}`
        : prompts.prepare;
      preparation = await execute(preparationPrompt, undefined, "preparation");
      resumeId = preparation.threadId;
      options.signal.throwIfAborted();
      if (options.variant === "large-history" && existsSync(join(options.cwd, "output/history-witness.txt"))) {
        throw new Error("Large-history preparation wrote its witness before the retained continuation");
      }
    }
    let archive: { threadId: string; archived: true; restored: true } | undefined;
    if (options.variant === "archived-history") {
      if (!resumeId || preparation?.status !== "completed") throw new Error("Archive requires a completed owned native task");
      const threadId = resumeId;
      const app = new GoldenAppServer({ ...options,
        onFrame: frame => options.onRecord("transport", JSON.stringify(frame)).then(() => {}),
        onStderr: text => options.onRecord("transport", text).then(() => {}),
      });
      let failure: unknown;
      try {
        native = app.rpc.pid ? ownedProcessIdentity(app.rpc.pid) : undefined;
        await checkpoint({ threadId }); await app.initialize();
        const request = (method: string, params: ObjectValue) => app.rpc.request(method, params, { signal: options.signal });
        const listed = async () => {
          const value = await request("thread/list", { archived: true, cwd: options.cwd, modelProviders: [options.modelProvider ?? "openai"], sourceKinds: ["exec"], limit: 100 });
          if (!object(value) || !Array.isArray(value.data) || value.data.some(thread => !object(thread) || typeof thread.id !== "string")) throw new Error("Native archived history did not return task identities");
          return value.data.map(thread => (thread as ObjectValue).id);
        };
        await request("thread/archive", { threadId });
        if (!(await listed()).includes(threadId)) throw new Error("The owned native task was not observed in archived history");
        const restored = await request("thread/unarchive", { threadId });
        if (!object(restored) || !object(restored.thread) || restored.thread.id !== threadId || (await listed()).includes(threadId)) throw new Error("The archived native task was not restored with the same identity");
        archive = { threadId, archived: true, restored: true };
      } catch (error) { failure = error; throw error; }
      finally {
        try { await app.close(); }
        catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], "Native archive control cleanup did not settle"); }
      }
    }
    const unicodePrompt = `${options.workload.prompt}\nAlso write output/unicode.txt containing exactly ${GOLDEN_UNICODE_WITNESS} followed by a newline, and include it in the artifact commit.`;
    const imagePrompt = `${options.workload.prompt}\nUse the image attached to this native turn to read its two-digit visual code, preserve any leading zero, and include the independently required attachment result in the artifact commit.`;
    const continuationPrompt = options.variant === "large-history"
      ? `${prompts.continue} Also write output/history-witness.txt with the exact fact from the preceding turn followed by a newline; do not guess it from repository files.`
      : prompts.continue;
    const terminal = await execute(preparation ? continuationPrompt : options.variant === "unicode" ? unicodePrompt : options.variant === "tool-image" ? imagePrompt : options.workload.prompt, resumeId);
    const historyWitnessSha256 = options.variant === "large-history"
      ? createHash("sha256").update(`${largeHistoryWitness(options.workload)}\n`).digest("hex") : undefined;
    return { ...terminal, variant: options.variant, toolItems, ...(preparation ? { preparation } : {}), ...(archive ? { archive } : {}),
      ...(historyWitnessSha256 ? { historyWitnessSha256 } : {}), ...(attachedImageSha256 ? { attachedImageSha256 } : {}) };
  }
  let app!: GoldenAppServer;
  app = new GoldenAppServer({ ...options, artifactRepository: options.cwd, onFrame: async frame => {
    const { tool, phase } = ownedNativeActivity(frame, app?.state() ?? {});
    if (tool) toolItems++;
    await options.onRecord("transport", JSON.stringify(frame), phase, frame.receivedAtMs);
  }, onStderr: text => options.onRecord("transport", text).then(() => {}) });
  let failure: unknown;
  try {
    native = app.rpc.pid ? ownedProcessIdentity(app.rpc.pid) : undefined;
    await checkpoint();
    await app.initialize(); await app.openThread();
    const scenario = await runStructuredScenario({ ...options, app, checkpoint });
    return { status: "completed" as const, threadId: app.state().threadId, variant: options.variant, scenario, toolItems };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await app.close(); }
    catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], "Native scenario cleanup did not settle"); }
  }
}
