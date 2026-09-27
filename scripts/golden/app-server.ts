import { isProGeneration } from "../../src/campaign-policy";
import { createHash } from "node:crypto";
import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { NativeRpc, NativeRpcError } from "./native-protocol";
import { goldenArtifactWritableRoots } from "./runtime-config";
import { DiagnosticError } from "../../src/diagnostics/problems";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export interface NativeTurn { id: string; status: "inProgress" | "completed" | "interrupted" | "failed"; items: unknown[]; error?: unknown }
export interface TurnInput { text: string; images?: readonly string[] }
interface ActiveTurn { submission: "submitting" | "accepted" | "uncertain"; id?: string }
interface CompactTurn { started: boolean; terminal?: NativeTurn }
interface ActiveCompaction {
  submission: "submitting" | "accepted" | "uncertain";
  turns: Map<string, CompactTurn>;
  turnId?: string;
  itemId?: string;
  itemCompleted: boolean;
  resolve(value: NativeCompaction): void;
  reject(error: Error): void;
}
export interface NativeCompaction { threadId: string; turnId: string; itemId: string; turn: NativeTurn }
export class NativeCompactionTerminalError extends NativeRpcError {
  constructor(readonly threadId: string, readonly turn: NativeTurn) {
    super("The native compaction turn ended without a completed compaction item", "native_compaction_failed");
  }
}
const invalid = (message: string) => new NativeRpcError(message, "native_protocol_invalid", true);
export function readNativeTurn(value: unknown): NativeTurn {
  if (!object(value) || typeof value.id !== "string" || !value.id || !["inProgress", "completed", "interrupted", "failed"].includes(String(value.status)) || !Array.isArray(value.items)) throw invalid("Native turn response is missing its identity, status or items");
  return value as unknown as NativeTurn;
}
export function nativePlanHashes(turn: NativeTurn): string[] {
  return turn.items.flatMap(item => object(item) && item.type === "plan" && typeof item.text === "string" && item.text.trim() ? [createHash("sha256").update(item.text).digest("hex")] : []);
}
function inputParts(input: TurnInput): ObjectValue[] {
  if (!input.text.trim()) throw new Error("Golden turns require nonempty synthetic input");
  return [{ type: "text", text: input.text, text_elements: [] }, ...(input.images ?? []).map(path => {
    if (!path.startsWith("/")) throw new Error("Native image attachments require absolute fixture paths");
    return { type: "localImage", path };
  })];
}

/** The installed native protocol owns modes and turn transitions. Diagnostic consumers receive every frame. */
export class GoldenAppServer {
  readonly rpc: NativeRpc;
  private initialized = false;
  private threadId?: string;
  private active?: ActiveTurn;
  private compacting?: ActiveCompaction;
  private readonly completed = new Map<string, NativeTurn>();
  private readonly completedPlans = new Map<string, string[]>();
  private readonly reconnecting = new Map<string, { count: number; firstAt: number; lastAt: number }>();
  constructor(private readonly options: {
    executable: string; args?: string[]; cwd: string; env: NodeJS.ProcessEnv; route: ChatGptWebModelRoute; modelProvider?: string; artifactRepository?: string;
    onFrame: ConstructorParameters<typeof NativeRpc>[0]["onFrame"];
    onStderr?: ConstructorParameters<typeof NativeRpc>[0]["onStderr"];
    onServerRequest?: ConstructorParameters<typeof NativeRpc>[0]["onServerRequest"];
  }) {
    if (isProGeneration(options.route) || options.route.interactionMode === "manual") throw new Error("The automatic golden driver requires a permitted non-Pro automatic route");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.modelProvider ?? "openai")) throw new Error("Native provider requires its configured identifier");
    this.rpc = new NativeRpc({ ...options, args: options.args ?? ["app-server", "--listen", "stdio://"], onFrame: async frame => {
      await options.onFrame(frame);
      if (frame.direction !== "received" || !object(frame.message.params)) return;
      const params = frame.message.params;
      if (!this.threadId || params.threadId !== this.threadId) return;
      const compaction = this.compacting;
      const method = frame.message.method;
      if (compaction && (method === "turn/started" || method === "turn/completed")) {
        const turn = readNativeTurn(params.turn);
        let observed = compaction.turns.get(turn.id);
        if (!observed) {
          if (compaction.turns.size >= 8) throw invalid("Native compaction produced too many unmatched turns");
          observed = { started: false }; compaction.turns.set(turn.id, observed);
        }
        if (method === "turn/started") observed.started = true;
        else {
          if (turn.status === "inProgress") throw invalid("Native compaction completion is not terminal");
          observed.terminal = turn;
          // A failed turn may have no contextCompaction item. Only a started, uniquely
          // observed turn (or the item-bound turn) can settle this compaction owner.
          if (turn.status !== "completed" && observed.started
            && (compaction.turnId === turn.id || !compaction.turnId && compaction.turns.size === 1)) {
            compaction.reject(new NativeCompactionTerminalError(this.threadId, turn));
          }
        }
      }
      if (compaction && (method === "item/started" || method === "item/completed") && object(params.item) && params.item.type === "contextCompaction") {
        const turnId = params.turnId, itemId = params.item.id;
        if (typeof turnId !== "string" || !turnId || typeof itemId !== "string" || !itemId) throw invalid("Native compaction item lacks its turn or item identity");
        if (compaction.turnId && compaction.turnId !== turnId || compaction.itemId && compaction.itemId !== itemId) throw invalid("Native compaction changed its owned turn or item identity");
        compaction.turnId = turnId; compaction.itemId = itemId;
        if (method === "item/completed") compaction.itemCompleted = true;
      }
      if (compaction?.turnId && compaction.itemId && compaction.itemCompleted) {
        const observed = compaction.turns.get(compaction.turnId);
        if (observed?.started && observed.terminal) compaction.resolve({ threadId: this.threadId, turnId: compaction.turnId, itemId: compaction.itemId, turn: observed.terminal });
      }
      if (frame.message.method === "turn/started" && this.active) {
        const turn = readNativeTurn(params.turn);
        if (this.active.id && this.active.id !== turn.id) throw invalid("Another native turn started before the owned turn settled");
        this.active.id = turn.id;
      }
      if (frame.message.method === "item/completed" && object(params.item) && params.item.type === "plan" && typeof params.turnId === "string" && this.active?.id === params.turnId) {
        const text = params.item.text;
        if (typeof text !== "string" || !text.trim()) throw invalid("Native Plan item has no text");
        const plans = this.completedPlans.get(params.turnId) ?? [];
        if (plans.length >= 4) throw invalid("Native turn emitted too many Plan items");
        plans.push(createHash("sha256").update(text).digest("hex"));
        this.completedPlans.set(params.turnId, plans);
      }
      if (frame.message.method === "error" && this.active?.id === params.turnId && params.willRetry === true
        && object(params.error) && object(params.error.codexErrorInfo)
        && object(params.error.codexErrorInfo.responseStreamDisconnected)) {
        const now = frame.receivedAtMs ?? Date.now();
        const current = this.reconnecting.get(params.turnId as string) ?? { count: 0, firstAt: now, lastAt: now };
        current.count += 1; current.lastAt = now;
        this.reconnecting.set(params.turnId as string, current);
      }
      if (frame.message.method === "turn/completed") {
        const turn = readNativeTurn(params.turn);
        // Native compaction and ancillary work can settle on the same thread.
        // Only this driver's accepted turn may occupy its completion cache.
        if (!this.active?.id || turn.id !== this.active.id) return;
        if (turn.status === "inProgress") throw invalid("Native completion event still reports an active turn");
        this.completed.set(turn.id, turn);
      }
    } });
  }
  state() { return { threadId: this.threadId, turnId: this.active?.id, submission: this.active?.submission ?? "idle", compaction: this.compacting?.submission ?? "idle" }; }
  async initialize(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.initialized) throw new Error("Native client is already initialized");
    // Cold native startup has exceeded the ordinary acknowledgement budget before a
    // thread exists. Keep this read-only handshake separate from submission deadlines.
    const result = await this.rpc.request("initialize", { clientInfo: { name: "codex-chatgpt-web-golden", version: "1" }, capabilities: { experimentalApi: true } }, { timeoutMs: options.timeoutMs ?? 90_000 });
    if (!object(result) || typeof result.userAgent !== "string") throw invalid("Native initialization did not identify its client runtime");
    await this.rpc.notify("initialized"); this.initialized = true;
  }
  async openThread(resumeId?: string): Promise<string> {
    if (!this.initialized || this.threadId) throw new Error("Initialize one native client before opening its owned thread");
    const result = await this.rpc.request(resumeId ? "thread/resume" : "thread/start", {
      ...(resumeId ? { threadId: resumeId, excludeTurns: true } : { allowProviderModelFallback: false }),
      cwd: this.options.cwd, model: this.options.route.slug, modelProvider: this.options.modelProvider ?? "openai", approvalPolicy: "never", sandbox: "workspace-write",
      config: { model_reasoning_effort: this.options.route.codexEffort, ...(this.options.artifactRepository ? { "sandbox_workspace_write.writable_roots": goldenArtifactWritableRoots(this.options.artifactRepository) } : {}) },
    });
    if (!object(result) || !object(result.thread) || typeof result.thread.id !== "string" || !result.thread.id) throw invalid("Native thread response did not contain a thread identity");
    if (resumeId && result.thread.id !== resumeId) throw invalid("Native resume returned another thread");
    if (result.model !== this.options.route.slug || result.modelProvider !== (this.options.modelProvider ?? "openai") || result.cwd !== this.options.cwd || (result.reasoningEffort != null && result.reasoningEffort !== this.options.route.codexEffort)) throw invalid("Native thread configuration differs from the requested model, provider, effort or workspace");
    this.threadId = result.thread.id; return this.threadId;
  }
  async startTurn(input: TurnInput & { mode?: "plan" | "default"; route?: ChatGptWebModelRoute; acknowledgementTimeoutMs?: number }): Promise<NativeTurn> {
    if (!this.threadId) throw new Error("Open an owned native thread first");
    if (this.active || this.compacting) throw new NativeRpcError("The previous native submission has not settled", "native_turn_unsettled", true);
    const route = input.route ?? this.options.route;
    if (isProGeneration(route) || route.interactionMode !== "automatic") throw new Error("The automatic golden driver requires a permitted non-Pro automatic route");
    const parts = inputParts(input);
    this.completedPlans.clear(); this.reconnecting.clear();
    const active: ActiveTurn = { submission: "submitting" }; this.active = active;
    try {
      const result = await this.rpc.request("turn/start", {
        threadId: this.threadId, input: parts, model: route.slug, effort: route.codexEffort,
        collaborationMode: { mode: input.mode ?? "default", settings: { model: route.slug, reasoning_effort: route.codexEffort, developer_instructions: null } },
      }, { timeoutMs: input.acknowledgementTimeoutMs });
      if (!object(result)) throw invalid("Native turn acknowledgement is not an object");
      const turn = readNativeTurn(result.turn);
      if (active.id && active.id !== turn.id) throw invalid("Native start acknowledgement differs from the observed turn");
      active.id = turn.id; active.submission = "accepted";
      // Terminal notification is still required; an acknowledgement alone cannot establish cleanup.
      return turn;
    } catch (error) {
      if (error instanceof NativeRpcError && error.code === "native_rpc_rejected" && !active.id) this.active = undefined;
      else active.submission = "uncertain";
      throw error;
    }
  }
  private requireTurn(turnId: string): ActiveTurn {
    if (!this.threadId || !this.active || this.active.id !== turnId) throw new NativeRpcError("Action does not identify the owned active native turn", "native_turn_mismatch", true);
    return this.active;
  }
  async steer(turnId: string, input: TurnInput): Promise<void> {
    this.requireTurn(turnId);
    const result = await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: turnId, input: inputParts(input) });
    if (!object(result) || result.turnId !== turnId) throw invalid("Native steering acknowledgement differs from its required turn");
  }
  async interrupt(turnId: string): Promise<void> {
    this.requireTurn(turnId);
    await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId });
  }
  /** RPC acknowledgement is only admission; the exact compaction item and terminal turn settle the operation. */
  async compact(options: { acknowledgementTimeoutMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NativeCompaction> {
    if (!this.threadId) throw new Error("Open an owned native thread first");
    if (this.active || this.compacting) throw new NativeRpcError("The previous native submission has not settled", "native_turn_unsettled", true);
    options.signal?.throwIfAborted();
    let resolve!: (value: NativeCompaction) => void, reject!: (error: Error) => void;
    const terminal = new Promise<NativeCompaction>((settle, fail) => { resolve = settle; reject = fail; });
    void terminal.catch(() => {});
    const operation: ActiveCompaction = { submission: "submitting", turns: new Map(), itemCompleted: false, resolve, reject };
    this.compacting = operation;
    try {
      const response = await this.rpc.request("thread/compact/start", { threadId: this.threadId }, { timeoutMs: options.acknowledgementTimeoutMs, signal: options.signal });
      if (!object(response)) throw invalid("Native compact acknowledgement is not an object");
      operation.submission = "accepted";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let rejectObservation!: (error: Error) => void;
      const observation = new Promise<never>((_, reject) => { rejectObservation = reject; });
      const aborted = () => rejectObservation(new NativeRpcError("Native compaction observation was cancelled", "native_observation_cancelled", true));
      timeout = setTimeout(() => rejectObservation(new NativeRpcError("Native compaction terminal was not observed", "native_event_timeout", true)), options.timeoutMs ?? 30_000);
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
      let result: NativeCompaction;
      try { result = await Promise.race([terminal, observation]); }
      finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", aborted); }
      if (this.compacting !== operation) throw invalid("Native compaction ownership changed while waiting");
      this.compacting = undefined;
      return result;
    } catch (error) {
      if (error instanceof NativeCompactionTerminalError
        || error instanceof NativeRpcError && error.code === "native_rpc_rejected" && !operation.turnId && !operation.turns.size) this.compacting = undefined;
      else operation.submission = "uncertain";
      throw error;
    }
  }
  async waitForCompletion(turnId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NativeTurn> {
    const active = this.requireTurn(turnId);
    let turn = this.completed.get(turnId);
    if (!turn) {
      try {
        const params = await this.rpc.waitFor("turn/completed", params => params.threadId === this.threadId && object(params.turn) && params.turn.id === turnId, options);
        turn = readNativeTurn(params.turn);
      } catch (error) {
        const reconnecting = this.reconnecting.get(turnId);
        if (error instanceof NativeRpcError && error.code === "native_event_timeout" && reconnecting && reconnecting.count >= 2) {
          throw new DiagnosticError({ code: "native_response_reconnecting_timeout", message: "Native Codex repeatedly reported a disconnected response stream and did not complete its turn", origin: "golden-native", retryable: false,
            findings: [{ message: `reconnectEvents=${reconnecting.count}; observedSpanMs=${Math.max(0, Math.round(reconnecting.lastAt - reconnecting.firstAt))}` }],
            evidenceMissing: "The accepted native turn has no terminal outcome; its submission and tool effects must not be replayed automatically." });
        }
        throw error;
      }
    }
    if (turn.status === "inProgress") throw invalid("Native completion is not terminal");
    if (this.active !== active) throw invalid("Native completion ownership changed while waiting");
    this.completed.delete(turnId); this.reconnecting.delete(turnId); this.active = undefined;
    return turn;
  }
  /** A native terminal snapshot may omit items already delivered as owned item events. */
  takePlanHashes(turn: NativeTurn): string[] {
    const events = this.completedPlans.get(turn.id) ?? [];
    this.completedPlans.delete(turn.id);
    const snapshot = nativePlanHashes(turn);
    if (events.length && snapshot.length && JSON.stringify(events) !== JSON.stringify(snapshot)) throw invalid("Native Plan events disagree with the completed turn");
    return events.length ? events : snapshot;
  }
  close(graceMs?: number): Promise<void> {
    this.compacting?.reject(new NativeRpcError("Native compaction owner is closing", "native_process_closing", true));
    return this.rpc.close(graceMs).finally(() => { this.compacting = undefined; this.completed.clear(); this.completedPlans.clear(); this.reconnecting.clear(); });
  }
}

/** Cold native SQLite initialization is serialized before concurrent consumers share this home. No thread or generation is created. */
export async function initializeGoldenNativeHome(options: ConstructorParameters<typeof GoldenAppServer>[0] & { signal: AbortSignal; onLaunch(pid: number): void | Promise<void> }): Promise<void> {
  options.signal.throwIfAborted();
  const app = new GoldenAppServer(options);
  let failure: unknown;
  try {
    if (!app.rpc.pid) throw new Error("Native home initialization has no owned process");
    await options.onLaunch(app.rpc.pid);
    await app.initialize();
    options.signal.throwIfAborted();
  } catch (error) { failure = error; throw error; }
  finally {
    try { await app.close(); }
    catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], "Native home initialization cleanup did not settle"); }
  }
}
