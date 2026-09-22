import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { readNativeTurn, nativePlanHashes, type NativeTurn } from "./app-server";
import { NativeRpc, NativeRpcError } from "./native-protocol";
import { NativeScenarioFailure } from "./structured-scenarios";
import { GoldenTui } from "./tui";
import { structuredScenarioPrompts, type GoldenWorkload } from "./workloads";
import type { NativeScenarioCheckpoint } from "./native-scenarios";
import type { OwnedProcess } from "./workspace";
import { findNativeFailure } from "./native-process";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (message: string) => new NativeRpcError(message, "native_tui_evidence_missing", true);
interface TitleTask { threadId: string; active: boolean; idle: boolean }

export class NativeTuiTitleFailure extends NativeRpcError {
  constructor(readonly threadId: string) {
    super(`Native TUI title task ${threadId} failed`, "native_tui_title_failed", true);
  }
}

export function findNativeTuiTitleFailure(error: unknown): NativeTuiTitleFailure | undefined {
  return findNativeFailure(error, (value): value is NativeTuiTitleFailure => value instanceof NativeTuiTitleFailure);
}

/** Real terminal inputs with native readback; provider/title acceptance belongs to the live evidence owner. */
export async function runTuiScenario(input: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; route: ChatGptWebModelRoute; workload: GoldenWorkload;
  modelProvider?: string; signal: AbortSignal; timeoutMs: number;
  onRecord(category: "prompt" | "transport", text: string): Promise<unknown>;
  checkpoint(input: NativeScenarioCheckpoint): void | Promise<void>;
}) {
  const transportControl = new AbortController();
  const options = { ...input, signal: AbortSignal.any([input.signal, transportControl.signal]) };
  options.signal.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Native TUI scenario requires a finite observation deadline");
  const tmux = Bun.which("tmux", { PATH: options.env.PATH });
  if (!tmux) throw new NativeRpcError("Native TUI scenario requires tmux", "native_tui_unavailable");
  const root = mkdtempSync(join(tmpdir(), "golden-plan-"));
  const titles = new Map<string, TitleTask>(), states = new Map<string, string>();
  let tui: GoldenTui | undefined, rpc: NativeRpc | undefined, native: OwnedProcess | undefined, threadId: string | undefined, failure: unknown, transportFailure: Error | undefined;
  const turns: NativeTurn[] = [];
  const request = (method: string, params: Record<string, unknown>) => rpc!.request(method, params, { signal: options.signal, timeoutMs: Math.min(options.timeoutMs, 30000) });
  const checkpoint = async (turnId?: string) => {
    if (!native) throw missing("Native TUI process identity is unavailable");
    await options.checkpoint({ native, ...(threadId ? { threadId } : {}), ...(turnId ? { turnId } : {}) });
  };
  const poll = async <T>(read: () => Promise<T | undefined>, description: string): Promise<T> => {
    const deadline = performance.now() + options.timeoutMs;
    for (;;) {
      options.signal.throwIfAborted();
      if (transportFailure) throw transportFailure;
      const value = await read();
      if (value !== undefined) return value;
      if (performance.now() >= deadline) throw missing(description);
      await wait(250, undefined, { signal: options.signal });
    }
  };
  const list = async () => {
    const result = await request("thread/list", { cwd: options.cwd, limit: 10 });
    if (!object(result) || !Array.isArray(result.data) || result.nextCursor) throw missing("TUI task listing is missing or exceeds the fresh task boundary");
    if (result.data.some(thread => !object(thread) || typeof thread.id !== "string" || thread.cwd !== options.cwd)) throw missing("TUI task listing changed its owned directory or identity");
    return result.data as Record<string, unknown>[];
  };
  const finish = async (index: number) => {
    let known: string | undefined;
    const terminal = await poll(async () => {
      // Global status frames arrive without retaining every token. Read once at
      // admission and when idle, avoiding repeated full-history capture while active.
      if (known && states.get(threadId!) === "active") return;
      const result = await request("thread/read", { threadId, includeTurns: true });
      if (!object(result) || !object(result.thread) || result.thread.id !== threadId || !Array.isArray(result.thread.turns)) throw missing("TUI task readback lacks its exact native history");
      const read = result.thread.turns.map(readNativeTurn);
      if (read.length > index + 1 || read.slice(0, index).some((turn, position) => turn.id !== turns[position]?.id || turn.status !== "completed")) throw missing("TUI history changed or contains an unexpected turn");
      const turn = read[index];
      if (!turn) return;
      if (known && known !== turn.id) throw missing("TUI active turn identity changed");
      if (!known) { known = turn.id; await checkpoint(turn.id); }
      return turn.status === "inProgress" ? undefined : turn;
    }, "TUI native turn did not expose its terminal outcome");
    turns.push(terminal);
    if (terminal.status !== "completed") throw new NativeScenarioFailure(threadId!, turns);
    return terminal;
  };
  try {
    tui = await GoldenTui.start({ root, cwd: options.cwd, nativeExecutable: options.executable, tmuxExecutable: tmux, env: options.env, route: options.route, modelProvider: options.modelProvider, artifactRepository: options.cwd,
      onInput: async text => { await options.onRecord("prompt", text); options.signal.throwIfAborted(); },
      onSnapshot: text => options.onRecord("transport", JSON.stringify({ tuiSnapshot: text })).then(() => {}),
      onTransport: (stream, text) => options.onRecord("transport", JSON.stringify({ tuiStream: stream, text })).then(() => {}),
      onLaunch: async identities => { native = identities.appServer; await options.onRecord("transport", JSON.stringify({ tuiProcesses: identities })); await checkpoint(); },
    });
    await tui.waitForReady({ timeoutMs: options.timeoutMs, signal: options.signal });
    rpc = new NativeRpc({ socket: tui.controlIdentity(), onFailure: error => { transportFailure = error; transportControl.abort(error); }, onFrame: async frame => {
      if (frame.direction === "received" && object(frame.message.params)) {
        const params = frame.message.params;
        if (frame.message.method === "thread/started" && object(params.thread) && params.thread.ephemeral === true) {
          const thread = params.thread;
          if (typeof thread.id !== "string" || thread.cwd !== options.cwd || thread.model !== options.route.slug || thread.reasoningEffort !== options.route.codexEffort || thread.modelProvider !== (options.modelProvider ?? "openai") || thread.threadSource !== "system" || titles.size >= 4) throw missing("Ephemeral TUI work lacks the expected owned model and directory");
          titles.set(thread.id, { threadId: thread.id, active: false, idle: false });
        }
        if (frame.message.method === "thread/status/changed" && typeof params.threadId === "string" && object(params.status) && typeof params.status.type === "string") {
          if (!states.has(params.threadId) && states.size >= 256) throw missing("TUI task lifecycle observations exceeded their bound");
          states.set(params.threadId, params.status.type);
          const title = titles.get(params.threadId);
          if (title) { if (params.status.type === "active") { title.active = true; title.idle = false; } else if (params.status.type === "idle" && title.active) title.idle = true; }
        }
      }
      await options.onRecord("transport", JSON.stringify(frame));
      // Retain the native failure before terminating observation. Check registered
      // titles against all states so status-before-start ordering also fails closed.
      for (const title of titles.values()) {
        if (states.get(title.threadId) === "systemError") {
          throw new NativeTuiTitleFailure(title.threadId);
        }
      }
    } });
    await request("initialize", { clientInfo: { name: "golden_tui_observer", version: "1" }, capabilities: { experimentalApi: true } });
    await rpc.notify("initialized");
    if ((await list()).length) throw missing("TUI scenario requires a fresh disposable task directory");
    await tui.submit("/plan");
    await tui.waitForView(text => text.includes("Plan mode") && !text.includes("switch to Plan mode"), { timeoutMs: options.timeoutMs, signal: options.signal });
    await tui.submit(structuredScenarioPrompts(options.workload).plan);
    threadId = await poll(async () => {
      const threads = (await list()).filter(thread => thread.ephemeral === false);
      if (threads.length > 1) throw missing("TUI scenario created multiple primary native tasks");
      const thread = threads[0];
      if (!thread) return;
      if (thread.modelProvider !== (options.modelProvider ?? "openai") || thread.model !== options.route.slug || thread.reasoningEffort !== options.route.codexEffort) throw missing("TUI native task did not retain its requested route");
      return thread.id as string;
    }, "TUI prompt lacks its persisted native task identity");
    await checkpoint();
    const plan = await finish(0);
    const planHashes = nativePlanHashes(plan);
    if (!planHashes.length) throw missing("TUI Plan turn completed without a native proposed plan");
    await tui.waitForView(text => text.includes("Implement this plan") && text.includes("› 1. Yes, implement this plan"), { timeoutMs: options.timeoutMs, signal: options.signal });
    options.signal.throwIfAborted();
    await options.onRecord("prompt", JSON.stringify({ tuiKey: "Enter", action: "accept-plan", threadId, planTurnId: plan.id }));
    options.signal.throwIfAborted(); tui.key("Enter");
    await finish(1);
    const titleTasks = await poll(async () => titles.size && [...titles.values()].every(title => title.active && title.idle) ? [...titles.values()] : undefined, "TUI ancillary title work did not expose its active-to-idle lifecycle");
    await tui.snapshot();
    return { status: "completed" as const, threadId, variant: "plan-tui-execute" as const,
      toolItems: turns.flatMap(turn => turn.items).filter(item => object(item) && ["commandExecution", "fileChange", "mcpToolCall"].includes(String(item.type))).length,
      scenario: { variant: "plan-tui-execute" as const, turns, planHashes, titleTasks },
    };
  } catch (error) {
    // Node timer cancellation wraps the reason in AbortError. Preserve the
    // observed native failure when that cancellation ended the polling loop.
    failure = transportFailure && options.signal.reason === transportFailure
      && error instanceof Error && error.name === "AbortError" ? transportFailure : error;
    throw failure;
  }
  finally {
    const cleanup: unknown[] = [];
    try { await rpc?.close(1000); } catch (error) { cleanup.push(error); }
    try { await tui?.close(); } catch (error) { cleanup.push(error); }
    if (!cleanup.length) rmSync(root, { recursive: true, force: true });
    else throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "TUI scenario cleanup did not settle");
  }
}
