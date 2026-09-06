import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CaptureStateSchema, CaptureWriteResultSchema, QueryResultSchema, StatusSchema, WorkerInvocationSchema, WorkerResponseSchema, unavailableStatus, type DiagnosticEvent, type DiagnosticQuery, type CaptureCommand, type ExportOptions, type WorkerRequest, type DiagnosticStatus } from "./contracts";
import { sanitizeEvent } from "./privacy";
import { DiagnosticRequestError } from "./request-error";
import { CopyOptionsSchema, CopyReportSchema, ExportOptionsSchema, ReportResultSchema, type CopyOptions } from "./contracts";

export interface WorkerInvocation { executable: string; args: string[]; cwd?: string; }
type Request = WorkerRequest extends infer T ? T extends WorkerRequest ? Omit<T, "id"> : never : never;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; bytes: number };
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

/** Cross-platform bounded worker transport, usable by Electron and standalone Bun processes. */
export class DiagnosticsClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
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
  private readonly exit: Promise<void>;
  private listeners = new Set<() => void>();
  private captures = CaptureStateSchema.parse({});

  constructor(invocation: WorkerInvocation) {
    invocation = WorkerInvocationSchema.parse(invocation);
    this.child = spawn(invocation.executable, invocation.args, { cwd: invocation.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child.stdin.on("error", () => { this.failure = "Diagnostic worker input is unavailable"; });
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 4 * 1024 * 1024) { this.failure = "Diagnostic worker exceeded its output bound"; this.child.kill(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const response = WorkerResponseSchema.parse(JSON.parse(line)); const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.responded = true;
          clearTimeout(pending.timer); this.pending.delete(response.id); this.pendingBytes -= pending.bytes;
          if (response.ok === true) pending.resolve(response.result);
          else pending.reject(new DiagnosticRequestError(response.code ?? "unavailable"));
        } catch { this.failure = "Diagnostic worker returned an invalid response"; }
      }
    });
    // Drain, but never persist raw worker errors (which may embed user paths or input).
    this.child.stderr.on("data", () => { this.failure = "Diagnostic worker reported an internal error"; });
    this.exit = new Promise(resolve => {
      const settle = () => {
        this.stopped = true; clearInterval(this.ticker); clearInterval(this.controlTicker);
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Diagnostic worker stopped")); }
        this.pending.clear(); this.pendingBytes = 0; resolve();
      };
      this.child.once("error", () => { this.failure = "Diagnostic worker could not start"; settle(); });
      this.child.once("close", () => { if (!this.closed) this.failure ??= "Diagnostic worker stopped unexpectedly"; settle(); });
    });
    this.ticker = setInterval(() => { void this.flush(); }, 100); this.ticker.unref();
    this.controlTicker = setInterval(() => { void this.refreshCaptureState().catch(() => {}); }, 5000); this.controlTicker.unref();
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
    if (this.stopped || this.pending.size >= 32) throw new Error("Diagnostics worker is unavailable or busy");
    const id = randomUUID();
    const message = `${JSON.stringify({ ...request, id })}\n`;
    const bytes = Buffer.byteLength(message);
    if (bytes > 2 * 1024 * 1024) throw new Error("Diagnostics request exceeded its size limit");
    if (Math.max(this.pendingBytes, this.child.stdin.writableLength) + bytes > MAX_QUEUE_BYTES) throw new Error("Diagnostics worker input is busy; request byte budget reached");
    const abort = () => { void this.request({ method: "cancel", requestId: id }).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) this.pendingBytes -= bytes;
        // An unresponsive transport may still own buffered bytes. Retire it before accepting more.
        this.failure = "Diagnostic worker request timed out"; this.stopped = true; this.child.kill();
        reject(new DiagnosticRequestError("timeout"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, bytes }); this.pendingBytes += bytes;
      this.child.stdin.write(message, error => { if (error) { clearTimeout(timer); if (this.pending.delete(id)) this.pendingBytes -= bytes; reject(new Error("Diagnostics worker input closed")); } });
    }).finally(() => signal?.removeEventListener("abort", abort));
  }
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.stopped || !this.queue.length && this.dropped === this.reportedDrops) return;
    this.flushing = (async () => {
      while (this.queue.length && !this.stopped) {
        const batch = this.queue.splice(0, 128); this.queueBytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
        try { await this.request({ method: "append", events: batch.map(item => item.event) }); this.failure = undefined; }
        catch { this.dropped += batch.length; this.failure = "Some diagnostic records could not be persisted"; break; }
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
    catch { value = { ...unavailableStatus("Collection is unavailable; retained records may still exist. Check disk space, permissions, and component versions"), captures: this.captures }; }
    return { ...value, dropped: value.dropped + this.dropped - this.reportedDrops, notices: [...value.notices, ...(this.failure ? [this.failure] : []), ...(this.queue.length ? [`${this.queue.length} records waiting for persistence`] : [])] };
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
