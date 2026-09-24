import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import { isProGeneration } from "../../src/campaign-policy";
import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { OwnedNativeProcess, NativeRpcError, findNativeFailure, type NativeExit } from "./native-process";
import { DiagnosticError } from "../../src/diagnostics/problems";
import type { OwnedProcess } from "./workspace";
import { goldenArtifactWritableRoots } from "./runtime-config";

export interface NativeExecEvent { type: string; [key: string]: unknown }
export interface NativeExecOutcome {
  threadId: string; status: "completed" | "failed"; terminal: NativeExecEvent; observedItems: number; exit: NativeExit;
}

/** Exec has no guaranteed native turn ID or typed provider code; preserve what it actually reports. */
export class NativeExecFailure extends DiagnosticError {
  readonly nativeExecFailure: { phase: "preparation" | "execution"; outcome: NativeExecOutcome };
  constructor(outcome: NativeExecOutcome, phase: "preparation" | "execution") {
    super({ code: "native_exec_failed", message: `Native exec ${phase} failed`, stage: `native_${phase}`, origin: "native", retryable: false, recovery: "unknown",
      ...(outcome.exit.code !== null ? { exitCode: outcome.exit.code } : {}), signal: outcome.exit.signal,
    });
    this.nativeExecFailure = { phase, outcome: structuredClone(outcome) };
  }
}

export function findNativeExecFailure(error: unknown): NativeExecFailure | undefined {
  return findNativeFailure(error, (value): value is NativeExecFailure => value instanceof NativeExecFailure);
}
export function nativeExecArgs(input: { route: ChatGptWebModelRoute; modelProvider?: string; resumeId?: string; images?: readonly string[]; artifactRepository?: string }): string[] {
  if (isProGeneration(input.route) || input.route.interactionMode !== "automatic") throw new Error("Golden exec requires a permitted non-Pro automatic route");
  if (input.resumeId !== undefined && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.resumeId)) throw new Error("Resume requires the exact captured native thread UUID");
  const modelProvider = input.modelProvider ?? "openai";
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(modelProvider)) throw new Error("Native provider requires its configured identifier");
  const args = ["exec", "--json", "--color", "never", "--sandbox", "workspace-write", "-c", 'approval_policy="never"', "-c", `model_provider=${JSON.stringify(modelProvider)}`, "-c", `model_reasoning_effort=${JSON.stringify(input.route.codexEffort)}`, "--model", input.route.slug];
  if (input.artifactRepository) args.push("-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(goldenArtifactWritableRoots(input.artifactRepository))}`);
  if (input.resumeId) args.push("resume", input.resumeId);
  for (const path of input.images ?? []) {
    if (!path.startsWith("/")) throw new Error("Native images require absolute fixture paths");
    args.push("--image", path);
  }
  args.push("-"); return args;
}

/** One submission. Timeout/cancellation stops observation and cleanup; it never retries the prompt. */
export async function runNativeExec(options: {
  executable: string; cwd: string; env: NodeJS.ProcessEnv; route: ChatGptWebModelRoute; modelProvider?: string; prompt: string; resumeId?: string; images?: readonly string[]; artifactRepository?: string;
  timeoutMs: number; signal?: AbortSignal; maxFrameBytes?: number;
  onInput(prompt: string): void | Promise<void>;
  onLaunch(identity: OwnedProcess): void | Promise<void>;
  onEvent(event: NativeExecEvent, receivedAtMs: number): void | Promise<void>;
  onStderr(text: string): void | Promise<void>;
}): Promise<NativeExecOutcome> {
  options.signal?.throwIfAborted();
  if (!options.prompt.trim() || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Native exec requires input and a finite attempt deadline");
  const args = nativeExecArgs(options), max = options.maxFrameBytes ?? 16 * 1024 * 1024;
  await options.onInput(options.prompt); options.signal?.throwIfAborted();
  let threadId: string | undefined, started = false, terminal: NativeExecEvent | undefined, observedItems = 0;
  const receive = async (line: string, receivedAtMs: number) => {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > max) throw new NativeRpcError("Native exec frame exceeded its declared limit", "native_protocol_too_large", true);
    let event: NativeExecEvent;
    try { event = JSON.parse(line); } catch { throw new NativeRpcError("Native exec emitted malformed JSON", "native_protocol_invalid", true); }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw new NativeRpcError("Native exec emitted an untyped event", "native_protocol_invalid", true);
    await options.onEvent(event, receivedAtMs);
    if (event.type === "thread.started") {
      if (threadId || typeof event.thread_id !== "string" || !event.thread_id || (options.resumeId && options.resumeId !== event.thread_id)) throw new NativeRpcError("Native exec thread identity changed", "native_protocol_invalid", true);
      threadId = event.thread_id;
    } else if (event.type === "turn.started") {
      if (!threadId || started || terminal) throw new NativeRpcError("Native exec started an unexpected additional turn", "native_protocol_invalid", true);
      started = true;
    } else if (event.type === "turn.completed" || event.type === "turn.failed") {
      if (!threadId || !started || terminal) throw new NativeRpcError("Native exec terminal event has no unique started turn", "native_protocol_invalid", true);
      terminal = event;
    } else if (event.type === "item.completed") observedItems++;
  };
  const native = new OwnedNativeProcess({ ...options, args, onFailure: () => {},
    stdout: async stream => {
      const decoder = new StringDecoder("utf8"); let text = "";
      for await (const chunk of stream) {
        const receivedAtMs = performance.timeOrigin + performance.now();
        text += decoder.write(Buffer.from(chunk));
        const complete: string[] = [];
        let newline: number;
        while ((newline = text.indexOf("\n")) >= 0) { const line = text.slice(0, newline); text = text.slice(newline + 1); complete.push(line); }
        if (Buffer.byteLength(text) > max) throw new NativeRpcError("Native exec frame exceeded its declared limit", "native_protocol_too_large", true);
        for (const line of complete) await receive(line, receivedAtMs);
      }
      text += decoder.end(); if (text.trim()) await receive(text, performance.timeOrigin + performance.now());
    },
    stderr: async stream => {
      const decoder = new StringDecoder("utf8");
      for await (const chunk of stream) { const text = decoder.write(Buffer.from(chunk)); if (text) await options.onStderr(text); }
      const text = decoder.end(); if (text) await options.onStderr(text);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined, stopped: NativeRpcError | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (code: string) => { stopped ??= new NativeRpcError("Native exec ended before its submitted work was observed to settle", code, true); native.signal("SIGTERM"); reject(stopped); };
    timer = setTimeout(() => stop("native_event_timeout"), options.timeoutMs);
    aborted = () => stop("native_observation_cancelled"); options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
  });
  void interrupted.catch(() => {});
  try {
    const exit = await Promise.race([interrupted, (async () => {
      if (!native.identity) throw new NativeRpcError("Native process identity could not be established", "native_process_ownership_missing");
      await options.onLaunch(native.identity); if (stopped) throw stopped; options.signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => native.child.stdin.end(options.prompt, (error?: Error | null) => error ? reject(error) : resolve()));
      return await native.result;
    })()]);
    if (!terminal || !threadId) throw new NativeRpcError("Native exec exited without a terminal turn record", "native_completion_missing", true);
    return { threadId, status: terminal.type === "turn.completed" && exit.code === 0 && exit.signal === null ? "completed" as const : "failed" as const, terminal, observedItems, exit };
  } finally {
    if (timer) clearTimeout(timer); if (aborted) options.signal?.removeEventListener("abort", aborted);
    await native.close(100);
  }
}
