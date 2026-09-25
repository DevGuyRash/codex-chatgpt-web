import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { CaptureStateSchema, CaptureWriteResultSchema, QueryResultSchema, StatusSchema, WorkerInvocationSchema, WorkerResponseSchema, WorkerTerminationSchema, unavailableStatus, type DiagnosticEvent, type DiagnosticQuery, type CaptureCommand, type ExportOptions, type WorkerRequest, type DiagnosticStatus } from "./contracts";
import { sanitizeEvent } from "./privacy";
import { WorkerRequestStartedSchema, WorkerRequestProgressSchema, WorkerStartupFailureSchema, type DiagnosticWritePhase } from "./contracts";
import { DiagnosticRequestError, type DiagnosticFailureDetails } from "./request-error";
import { CopyOptionsSchema, CopyReportSchema, ExportOptionsSchema, ReportResultSchema, type CopyOptions } from "./contracts";
import { ContentCaptureCommandSchema, ContentCaptureResultSchema, type ContentCaptureCommand } from "./contracts";

export interface WorkerInvocation { executable: string; args: string[]; cwd?: string; }
type Request = WorkerRequest extends infer T ? T extends WorkerRequest ? Omit<T, "id"> : never : never;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; bytes: number; method: WorkerRequest["method"]; action?: ContentCaptureCommand["action"]; requestedAt: number; deadlineAt: number; timeoutMs: number; extendForCommit?: () => void; workerStartedAt?: number; workerPhase?: DiagnosticWritePhase; workerPhaseAt?: number; inputWriteCompleted: boolean; inputWrittenAt?: number; cpuUsage: NodeJS.CpuUsage; maxEventLoopLagMs: number };
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
// SQLite may be waiting on host I/O after it reports commit progress. Grant one bounded
// extension for the default write budget; explicit short caller deadlines stay authoritative.
const COMMIT_PROGRESS_GRACE_MS = 15_000;
const MAX_COMMIT_REQUEST_MS = 20_000;

/** Cross-platform bounded worker transport, usable by Electron and standalone Bun processes. */
export class DiagnosticsClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly admissionWaiters = new Set<() => void>();
  private pendingBytes = 0;
  private readonly queue: { event: DiagnosticEvent; bytes: number }[] = [];
  private queueBytes = 0;
  private dropped = 0;
  private reportedDrops = 0;
  private flushing?: Promise<void>;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly controlTicker: ReturnType<typeof setInterval>;
  private stopped = false;
  private responded = false;
  private closed = false;
  private failure?: string;
  private startupFailure?: DiagnosticRequestError;
  private termination?: string;
  private readonly exit: Promise<void>;
  private listeners = new Set<() => void>();
  private captures = CaptureStateSchema.parse({});
  private lastTick = performance.now();

  private failureDetails(pending: Pending): DiagnosticFailureDetails {
    const now = performance.now(), cpu = process.cpuUsage(pending.cpuUsage);
    return { method: pending.method, ...(pending.action ? { action: pending.action } : {}),
      ...(pending.workerPhase ? { phase: pending.workerPhase } : {}), elapsedMs: Math.round(now - pending.requestedAt),
      ...(pending.workerStartedAt === undefined ? {} : { workerElapsedMs: Math.round(now - pending.workerStartedAt) }),
      inputBytes: pending.bytes, inputWriteCompleted: pending.inputWriteCompleted, inputBufferedBytes: this.child.stdin.writableLength,
      ...(pending.inputWrittenAt === undefined ? {} : { inputWrittenAfterMs: Math.round(pending.inputWrittenAt - pending.requestedAt) }),
      maxEventLoopLagMs: Math.round(Math.max(pending.maxEventLoopLagMs, now - this.lastTick - 100, 0)), parentCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    };
  }

  constructor(invocation: WorkerInvocation) {
    invocation = WorkerInvocationSchema.parse(invocation);
    this.child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child.stdin.on("error", () => { if (!this.startupFailure) this.failure = "Diagnostic worker input is unavailable"; });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 4 * 1024 * 1024) { this.failure = "Diagnostic worker exceeded its output bound"; this.child.kill(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const envelope: unknown = JSON.parse(line);
          const startup = WorkerStartupFailureSchema.safeParse(envelope);
          if (startup.success) {
            this.startupFailure = new DiagnosticRequestError(startup.data.code, startup.data.details);
            this.failure = `Diagnostic worker startup failed: ${this.startupFailure.message}`;
            this.stopped = true;
            for (const pending of this.pending.values()) {
              clearTimeout(pending.timer);
              pending.reject(new DiagnosticRequestError(startup.data.code, { ...this.failureDetails(pending), ...startup.data.details }));
            }
            this.pending.clear(); this.pendingBytes = 0;
            continue;
          }
          const started = WorkerRequestStartedSchema.safeParse(envelope);
          if (started.success) {
            const pending = this.pending.get(started.data.id);
            if (pending && pending.method === started.data.method) pending.workerStartedAt ??= performance.now();
            continue;
          }
          const termination = WorkerTerminationSchema.safeParse(envelope);
          const progress = WorkerRequestProgressSchema.safeParse(envelope);
          if (progress.success) {
            const pending = this.pending.get(progress.data.id);
            if (pending?.method === progress.data.method && pending.workerStartedAt !== undefined) {
              pending.workerPhase = progress.data.phase;
              pending.workerPhaseAt = performance.now();
              if (progress.data.phase === "commit") pending.extendForCommit?.();
            }
            continue;
          }
          if (termination.success) {
            if (!this.closed) { this.termination = `Diagnostic worker stopping (reason=${termination.data.reason})`; this.stopped = true; }
            continue;
          }
          const response = WorkerResponseSchema.parse(envelope); const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.responded = true;
          clearTimeout(pending.timer); this.pending.delete(response.id); this.pendingBytes -= pending.bytes;
          if (response.ok === true) pending.resolve(response.result);
          else pending.reject(new DiagnosticRequestError(response.code ?? "unavailable", { ...response.details, ...this.failureDetails(pending) }));
        } catch { this.failure = "Diagnostic worker returned an invalid response"; }
      }
    });
    // Drain, but never persist raw worker errors (which may embed user paths or input).
    this.child.stderr.on("data", () => { if (!this.startupFailure) this.failure = "Diagnostic worker reported an internal error"; });
    this.exit = new Promise(resolve => {
      const settle = () => {
        this.stopped = true; clearInterval(this.ticker); clearInterval(this.controlTicker);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DiagnosticRequestError("unavailable", this.failureDetails(pending))); }
        this.pending.clear(); this.pendingBytes = 0; resolve();
      };
      this.child.once("error", () => { this.failure = "Diagnostic worker could not start"; settle(); });
      this.child.once("close", (code, signal) => {
        if (!this.closed) {
          this.failure ??= "Diagnostic worker stopped unexpectedly";
          this.termination = `${this.termination ?? "Diagnostic worker exit"} (pid=${this.child.pid ?? "unknown"}; exitCode=${code ?? "unknown"}; signal=${signal ?? "none"})`;
        }
        settle();
      });
    });
    this.ticker = setInterval(() => {
      const now = performance.now(), lag = Math.max(0, now - this.lastTick - 100); this.lastTick = now;
      for (const pending of this.pending.values()) pending.maxEventLoopLagMs = Math.max(pending.maxEventLoopLagMs, lag);
      void this.flush();
    }, 100); this.ticker.unref();
    this.controlTicker = setInterval(() => {
      // A background poll must not impose its shorter deadline on work already
      // queued at the worker. Existing requests retain their own bounded deadlines.
      if (!this.pending.size && !this.stopped && !this.closed) void this.refreshCaptureState().catch(() => {});
    }, 5000); this.controlTicker.unref();
    void this.refreshCaptureState().catch(() => {});
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  debugEnabled(): boolean { return this.captures.debugUntil > Date.now(); }
  privateCaptureEnabled(): boolean { return this.captures.privateUntil > Date.now(); }
  async refreshCaptureState(): Promise<void> { this.captures = CaptureStateSchema.parse(await this.request({ method: "capture-status" }, this.responded ? 2000 : 10000)); }
  emit(input: DiagnosticEvent): void {
    if (this.closed || this.stopped) { this.dropped++; return; }
    let event: DiagnosticEvent;
    try { event = sanitizeEvent(input); } catch { this.dropped++; return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.queue.length >= 1024 || this.queueBytes + bytes > MAX_QUEUE_BYTES) {
      if (event.severity === "error" || event.kind === "span") {
        const index = this.queue.findIndex(item => item.event.severity !== "error" && item.event.kind !== "span");
        if (index >= 0) { const [old] = this.queue.splice(index, 1); this.queueBytes -= old.bytes; this.dropped++; }
        else { this.dropped++; return; }
      } else { this.dropped++; return; }
    }
    if (this.queueBytes + bytes > MAX_QUEUE_BYTES) { this.dropped++; return; }
    this.queue.push({ event, bytes }); this.queueBytes += bytes;
  }
  async request(request: Request, timeout = 5000, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    // Health reads enter only when earlier requests have settled. Their short
    // execution deadline must not terminate an in-budget write or export ahead
    // of them. Admission is separately bounded and does not send worker input.
    if (request.method === "status" || request.method === "capture-status") {
      const deadline = performance.now() + timeout;
      while (this.pending.size && !this.stopped) {
        signal?.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0 || this.admissionWaiters.size >= 32) throw new DiagnosticRequestError("busy", { method: request.method });
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.admissionWaiters.delete(wake); signal?.removeEventListener("abort", wake); resolve(); };
          const timer = setTimeout(wake, remaining);
          this.admissionWaiters.add(wake);
          signal?.addEventListener("abort", wake, { once: true });
        });
      }
      signal?.throwIfAborted();
    }
    if (this.stopped) throw this.startupFailure ?? new DiagnosticRequestError("unavailable");
    if (this.pending.size >= 32) throw new DiagnosticRequestError("busy");
    const id = randomUUID();
    const message = `${JSON.stringify({ ...request, id })}\n`;
    const bytes = Buffer.byteLength(message);
    if (bytes > 2 * 1024 * 1024) throw new Error("Diagnostics request exceeded its size limit");
    if (Math.max(this.pendingBytes, this.child.stdin.writableLength) + bytes > MAX_QUEUE_BYTES) throw new Error("Diagnostics worker input is busy; request byte budget reached");
    const abort = () => { void this.request({ method: "cancel", requestId: id }).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    const requestedAt = performance.now();
    return new Promise((resolve, reject) => {
      const onTimeout = () => {
        // A synchronous parent operation can delay both timers and readable events.
        // Drain the pending I/O turn before deciding that the worker did not answer.
        setImmediate(() => {
        const pending = this.pending.get(id);
        if (!pending || performance.now() < pending.deadlineAt) return;
        const details = this.failureDetails(pending);
        const pendingWork = [...this.pending.values()].map(pending => `${pending.method}:${pending.workerStartedAt === undefined ? "start-unobserved" : "started"}:${Math.round(performance.now() - pending.requestedAt)}ms${pending.workerPhase ? `:${pending.workerPhase}:${Math.round(performance.now() - pending.workerPhaseAt!)}ms` : ""}`).join(",");
        if (this.pending.delete(id)) this.pendingBytes -= bytes;
        // An unresponsive transport may still own buffered bytes. Retire it before accepting more.
        this.failure = `Diagnostic worker request timed out (method=${request.method}; timeoutMs=${pending.timeoutMs}) (elapsedMs=${Math.round(performance.now() - requestedAt)}; pendingRequests=${this.pending.size}; work=${pendingWork}) (${Object.entries(details).map(([key, value]) => `${key}=${value}`).join("; ")})`; this.stopped = true; this.child.kill();
        reject(new DiagnosticRequestError("timeout", details));
        });
      };
      const pending: Pending = { resolve, reject, timer: setTimeout(onTimeout, timeout), bytes, method: request.method,
        ...(request.method === "content-capture" ? { action: request.command.action } : {}),
        requestedAt, deadlineAt: requestedAt + timeout, timeoutMs: timeout,
        inputWriteCompleted: false, cpuUsage: process.cpuUsage(), maxEventLoopLagMs: 0 };
      if (timeout === 5000 && (request.method === "append" || request.method === "content-capture")) {
        let extended = false;
        pending.extendForCommit = () => {
          if (extended) return;
          extended = true;
          const deadlineAt = Math.min(requestedAt + MAX_COMMIT_REQUEST_MS, performance.now() + COMMIT_PROGRESS_GRACE_MS);
          if (deadlineAt <= pending.deadlineAt) return;
          clearTimeout(pending.timer);
          pending.deadlineAt = deadlineAt;
          pending.timeoutMs = Math.round(deadlineAt - requestedAt);
          pending.timer = setTimeout(onTimeout, Math.max(1, deadlineAt - performance.now()));
        };
      }
      this.pending.set(id, pending); this.pendingBytes += bytes;
      this.child.stdin.write(message, error => {
        const pending = this.pending.get(id);
        if (error) { if (pending) clearTimeout(pending.timer); if (this.pending.delete(id)) this.pendingBytes -= bytes; reject(new DiagnosticRequestError("unavailable", pending ? this.failureDetails(pending) : undefined)); }
        else if (pending) { pending.inputWriteCompleted = true; pending.inputWrittenAt = performance.now(); }
      });
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      for (const wake of this.admissionWaiters) wake();
    });
  }
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.stopped || !this.queue.length && this.dropped === this.reportedDrops) return;
    this.flushing = (async () => {
      while (this.queue.length && !this.stopped) {
        const batch = this.queue.splice(0, 128); this.queueBytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
        try { await this.request({ method: "append", events: batch.map(item => item.event) }); }
        catch { this.dropped += batch.length; this.failure ??= "Some diagnostic records could not be persisted"; break; }
      }
      const unreported = this.dropped - this.reportedDrops;
      if (unreported > 0 && !this.stopped) try { await this.request({ method: "dropped", count: Math.min(unreported, 1_000_000) }); this.reportedDrops += Math.min(unreported, 1_000_000); } catch { /* Local status retains the loss count. */ }
      for (const listener of this.listeners) { try { listener(); } catch { /* UI subscribers do not own ingestion. */ } }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  async status(): Promise<DiagnosticStatus> {
    let value: DiagnosticStatus;
    try { value = StatusSchema.parse(await this.request({ method: "status" }, this.responded ? 2000 : 10000)); this.captures = value.captures; }
    catch (error) { value = { ...unavailableStatus(error instanceof DiagnosticRequestError && error.code === "busy" ? "Collection status is temporarily unavailable while diagnostics is busy; current work retains its own deadline" : "Collection is unavailable; retained records may still exist. Check disk space, permissions, and component versions"), captures: this.captures }; }
    return { ...value, dropped: value.dropped + this.dropped - this.reportedDrops, notices: [...value.notices, ...(this.failure ? [this.failure] : []), ...(this.termination ? [this.termination] : []), ...(this.queue.length ? [`${this.queue.length} records waiting for persistence`] : [])] };
  }
  async query(query: DiagnosticQuery, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await this.request({ method: "query", query: { view: "events", limit: 100, ascending: false, ...query } }, 5000, signal);
    signal?.throwIfAborted(); return QueryResultSchema.parse(result);
  }
  async capture(command: CaptureCommand) { const state = CaptureStateSchema.parse(await this.request({ method: "capture", command })); this.captures = state; for (const listener of this.listeners) { try { listener(); } catch { /* Collection listeners cannot affect capture admission. */ } } return state; }
  async claimCapture(traceId: string): Promise<boolean> {
    const result: unknown = await this.request({ method: "capture-claim", traceId });
    return Boolean(result && typeof result === "object" && "allowed" in result && result.allowed === true);
  }
  async contentCapture(command: ContentCaptureCommand) { return ContentCaptureResultSchema.parse(await this.request({ method: "content-capture", command: ContentCaptureCommandSchema.parse(command) })); }
  async writeCapture(traceId: string, png: Buffer) {
    if (png.byteLength > 1024 * 1024) return CaptureWriteResultSchema.parse({ status: "omitted", reason: "too-large" });
    return CaptureWriteResultSchema.parse(await this.request({ method: "capture-write", traceId, png: png.toString("base64") }));
  }
  async clear(scope: "normal" | "private", confirmed: boolean) {
    if (!confirmed) throw new Error("Clearing diagnostics requires confirmation");
    await this.flush(); return StatusSchema.parse(await this.request({ method: "clear", scope, confirmed: true }));
  }
  async export(options: ExportOptions, destination: string) { return ReportResultSchema.parse(await this.request({ method: "export", options: ExportOptionsSchema.parse(options), destination }, 30_000)); }
  async copy(options: CopyOptions) { return CopyReportSchema.parse(await this.request({ method: "copy", options: CopyOptionsSchema.parse(options) }, 30_000)); }
  async close(): Promise<void> {
    if (this.closed) return this.exit;
    this.closed = true; clearInterval(this.ticker); clearInterval(this.controlTicker);
    const force = setTimeout(() => this.child.kill(), 6000);
    try { await this.flush(); if (!this.stopped) await this.request({ method: "close" }, 2000); } catch { this.child.kill(); }
    this.child.stdin.end();
    await this.exit; clearTimeout(force); this.listeners.clear();
  }
}
