import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { DiagnosticsClient, type WorkerInvocation } from "../../src/diagnostics/client";
import { Diagnostics, traceparent, type DiagnosticContext } from "../../src/diagnostics/instrumentation";
import { DiagnosticEventSchema, QuerySchema, QueryResultSchema, StatusSchema, CaptureCommandSchema, ExportOptionsSchema, type DiagnosticEvent, type Severity, type DiagnosticStatus } from "../../src/diagnostics/contracts";
import { safeAttributes, safeText, sanitizeEvent } from "../../src/diagnostics/privacy";
import { DiagnosticRequestIdSchema } from "../../src/diagnostics/contracts";
import { CopyOptionsSchema } from "../../src/diagnostics/contracts";
import { TraceIdSchema } from "../../src/diagnostics/contracts";
import { DiagnosticRequestError, requestFailure } from "../../src/diagnostics/request-error";
import { isDiagnosticCancellation } from "../../src/diagnostics/outcome";
export { isDiagnosticCancellation, diagnosticCancellation } from "../../src/diagnostics/outcome";
export { problemFor, runtimeFailure, withRecovery, DiagnosticError } from "../../src/diagnostics/problems";
export const redactText = safeText;
export const redactExportText = (text: string) => safeText(text, true);

/** Compatibility adapter for old emitters; raw payload-shaped fields are deliberately discarded. */
export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return safeText(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 64).map(sanitize);
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key,
    /authorization|cookie|runtimeKey|controlToken|password|secret|prompt|response|html|dom|content/i.test(key) ? "[redacted]" : typeof item === "object" ? "[structured value omitted]" : sanitize(item)]));
}
export function createLogger(options: { filePath: string; invocation?: WorkerInvocation; target?: string; environment?: DiagnosticEvent["environment"]; version?: string }) {
  const client = options.invocation ? new DiagnosticsClient(options.invocation) : undefined;
  const sink = { emit(event: DiagnosticEvent) {
    client?.emit(event);
  }, flush: () => client?.flush() ?? Promise.resolve() };
  const diagnostics = new Diagnostics(sink, { component: "launcher", environment: options.environment ?? "production", target: options.target ?? "base", version: options.version, debugEnabled: () => client?.debugEnabled() ?? false });
  const log = (severity: Severity, name: string, detail: unknown = {}) => {
    const attrs = safeAttributes(detail);
    // Legacy streams may contain model output/configuration. Keep only their structural occurrence.
    delete attrs.line; delete attrs.args; delete attrs.command; delete attrs.message;
    diagnostics.event(name, name.replace(/[._]/g, " "), attrs, severity);
  };
  const ready = client ? client.status().then(() => {}) : Promise.resolve();
  const imported = client ? ready.then(() => client.request({ method: "import", files: [`${options.filePath}.1`, options.filePath, resolve(dirname(options.filePath), "process-stream-errors.log")] }, 30_000)).catch(() => {}) : Promise.resolve();
  return {
    debug: (event: string, detail?: unknown) => log("debug", event, detail),
    info: (event: string, detail?: unknown) => log("info", event, detail),
    warn: (event: string, detail?: unknown) => log("warning", event, detail),
    error: (event: string, detail?: unknown) => log("error", event, detail),
    client, diagnostics, ready, imported,
    operation: <T>(name: string, action: () => Promise<T>) => diagnostics.run(name, action),
    event: (name: string, body: string, detail?: Record<string, unknown>) => diagnostics.event(name, body, detail),
    currentContext: () => { const current = diagnostics.context(); return current ? { traceId: current.traceId, spanId: current.spanId } : undefined; },
    environment: () => ({ CODEX_CHATGPT_WEB_TRACEPARENT: traceparent(diagnostics.context()) ?? "", CODEX_CHATGPT_WEB_DIAGNOSTICS_FD: "3", ...(options.invocation ? { CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER: JSON.stringify(options.invocation) } : {}) }),
    attachChild: (child: ChildProcess) => {
      const stream = child.stdio[3] as Readable | null;
      if (!stream) return;
      let buffer = ""; let discarded = false;
      const active = new Map<string, DiagnosticEvent>();
      stream.on("error", () => log("warning", "diagnostics.child_channel_failed"));
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!discarded && line.length <= 64 * 1024) {
            try {
              const event = sanitizeEvent(DiagnosticEventSchema.parse(JSON.parse(line))); sink.emit(event);
              if (event.span && event.traceId && event.spanId) {
                const key = `${event.traceId}:${event.spanId}`;
                if (event.span.outcome !== "running") active.delete(key);
                else if (active.size < 256 || active.has(key)) active.set(key, event);
                else log("warning", "diagnostics.child_tracking_limit");
              }
            } catch { log("warning", "diagnostics.child_record_rejected"); }
          }
          discarded = false;
        }
        if (buffer.length > 64 * 1024) { buffer = ""; discarded = true; log("warning", "diagnostics.child_record_truncated"); }
      });
      child.once("close", (code, signal) => {
        if (buffer.trim()) log("warning", "diagnostics.child_record_incomplete");
        for (const event of active.values()) {
          const outcome = code === 0 && !signal ? "unknown" : "interrupted";
          diagnostics.ingest({ ...event, id: randomUUID(), time: Date.now(), severity: "warning", body: "Observed child process exit without terminal stage evidence; no successful outcome is established", attributes: { ...event.attributes, "process.exit_code": code ?? -1, "process.signal": signal ?? "none", "diagnostics.observed_child_exit": true }, span: { ...event.span!, endTime: Date.now(), outcome } });
        }
        active.clear();
      });
    },
    close: async () => { await diagnostics.close(); await client?.close(); },
  };
}
export type DiagnosticLogger = ReturnType<typeof createLogger>;

/** Non-interactive native-package acceptance; the package runner supplies isolated data/output roots. */
export async function verifyPackagedDiagnostics(logger: DiagnosticLogger, destination: string, renderer: { executeJavaScript(script: string): Promise<unknown>; getZoomFactor(): number; setZoomFactor(factor: number): void }): Promise<void> {
  await logger.ready;
  if (!logger.client || !(await logger.client.status()).available) throw new Error("Packaged diagnostics storage is unavailable");
  const operation = logger.diagnostics.begin("packaged.diagnostics.acceptance");
  operation.problem(undefined, "Synthetic diagnostics package acceptance failure"); operation.end("failed");
  await logger.client.flush();
  const result = await logger.client.query({ traceId: operation.context.traceId, regex: "package acceptance failure" });
  if (!result.events.some(event => event.problem?.traceId === operation.context.traceId)) throw new Error("Packaged diagnostics lost correlated failure evidence");
  const status = StatusSchema.parse(await renderer.executeJavaScript("window.codexWebLauncher.diagnostics.status()"));
  const rendererResult = QueryResultSchema.parse(await renderer.executeJavaScript(`window.codexWebLauncher.diagnostics.query(${JSON.stringify({ traceId: operation.context.traceId })})`));
  if (!status.available || !rendererResult.events.some(event => event.problem?.traceId === operation.context.traceId)) throw new Error("Packaged renderer diagnostics IPC did not retrieve the observed failure");
  const invalid = await renderer.executeJavaScript('window.codexWebLauncher.diagnostics.query({ traceId: "invalid" })');
  if (!invalid || typeof invalid !== "object" || !("diagnosticFailure" in invalid) || invalid.diagnosticFailure !== true || !("code" in invalid) || invalid.code !== "invalid_query") throw new Error("Packaged diagnostics lost its failure code across IPC/contextBridge");
  const originalZoom = renderer.getZoomFactor();
  try {
    renderer.setZoomFactor(2);
    if (renderer.getZoomFactor() !== 2) throw new Error("Packaged renderer did not apply native 200% zoom");
    await renderer.executeJavaScript(`(async () => {
      const waitFor = async (description, query) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const value = query(); if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Native zoom acceptance: ' + description);
      };
      const button = name => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === name);
      (await waitFor('Diagnostics navigation unavailable', () => button('Diagnostics'))).click();
      (await waitFor('Capture controls unavailable', () => button('Capture & storage'))).click();
      const control = await waitFor('Debug control unavailable', () => button('Enable debug for 30 minutes'));
      control.scrollIntoView({ block: 'center', inline: 'nearest' }); control.focus();
      await waitFor('Control unreachable or horizontal overflow at 200% zoom', () => {
        const rect = control.getBoundingClientRect();
        return document.activeElement === control && rect.width > 0 && rect.height > 0
          && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
          && document.documentElement.scrollWidth <= innerWidth;
      });
      return true;
    })()`);
  } finally { renderer.setZoomFactor(originalZoom); }
  await logger.client.export({ format: "html", query: { traceId: operation.context.traceId } }, destination);
  const report = readFileSync(destination, "utf8");
  if (!report.includes("Synthetic diagnostics package acceptance failure") || !report.includes("Collection health")) throw new Error("Packaged diagnostics report is incomplete");
}

export function registerDiagnosticsIpc(options: {
  handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void;
  logger: DiagnosticLogger;
  chooseExport: (format: string) => Promise<string | undefined>;
  copyText: (text: string) => void;
  runtime?: { readConfig(): unknown; proxyHealth(config: object, timeoutMs: number): Promise<boolean> };
  reviewUpgrade?: () => Promise<unknown>;
}) {
  const { logger } = options;
  const handle: typeof options.handle = (channel, handler) => options.handle(channel, async (...args) => {
    try { return await handler(...args); }
    catch (error) { return requestFailure(error, channel.endsWith("export") ? "export_failed" : channel.endsWith("capture") ? "capture_failed" : channel.endsWith("clear") ? "clear_failed" : channel.endsWith("query") ? "query_failed" : "unavailable"); }
  });
  const client = logger.client;
  const requireClient = () => { if (!client) throw new Error("Diagnostic worker is unavailable"); return client; };
  const queries = new Map<string, AbortController>();
  const ownerId = (event: unknown) => {
    const sender = event && typeof event === "object" && "sender" in event ? event.sender : undefined;
    return sender && typeof sender === "object" && "id" in sender && typeof sender.id === "number" ? sender.id : 0;
  };
  let observed: DiagnosticStatus["runtime"];
  let observing: Promise<DiagnosticStatus["runtime"]> | undefined;
  const runtimeHealth = async (): Promise<DiagnosticStatus["runtime"]> => {
    if (observed && Date.now() - observed.checkedAt < 5000) return observed;
    if (observing) return observing;
    observing = (async () => {
      let state: NonNullable<DiagnosticStatus["runtime"]>["state"] = "unknown";
      try {
        if (options.runtime) {
          const config = options.runtime.readConfig();
          state = !config ? "unconfigured" : typeof config === "object" ? await options.runtime.proxyHealth(config, 500) ? "healthy" : "unavailable" : "unknown";
        }
      } catch { /* Unknown is distinct from an observed unhealthy endpoint; never expose raw errors. */ }
      observed = { state, checkedAt: Date.now() }; return observed;
    })().finally(() => { observing = undefined; });
    return observing;
  };
  handle("launcher:diagnostics-status", async () => {
    const [status, runtime] = await Promise.all([requireClient().status(), runtimeHealth()]);
    return { ...status, runtime };
  });
  handle("launcher:diagnostics-query", async (event, input, requestId = randomUUID()) => {
    const query = QuerySchema.parse(input);
    const key = `${ownerId(event)}:${DiagnosticRequestIdSchema.parse(requestId)}`;
    if (queries.has(key)) throw new DiagnosticRequestError("busy");
    if (queries.size >= 32) throw new DiagnosticRequestError("busy");
    const controller = new AbortController(); queries.set(key, controller);
    try { return await requireClient().query(query, controller.signal); } finally { queries.delete(key); }
  });
  handle("launcher:diagnostics-cancel", (event, requestId) => {
    queries.get(`${ownerId(event)}:${DiagnosticRequestIdSchema.parse(requestId)}`)?.abort();
  });
  handle("launcher:diagnostics-capture", (_event, input) => requireClient().capture(CaptureCommandSchema.parse(input)));
  handle("launcher:diagnostics-clear", (_event, scope, confirmed) => {
    if ((scope !== "normal" && scope !== "private") || confirmed !== true) throw new Error("Choose and confirm what to clear");
    return requireClient().clear(scope, true);
  });
  handle("launcher:diagnostics-export", async (_event, input) => {
    const parsed = ExportOptionsSchema.parse(input);
    const snapshotSequence = (await requireClient().status()).lastSequence;
    if (parsed.selection?.kind === "results") parsed.selection.query.snapshotSequence ??= snapshotSequence;
    else if (parsed.selection) parsed.selection.snapshotSequence ??= snapshotSequence;
    else parsed.query.snapshotSequence ??= snapshotSequence;
    const destination = await options.chooseExport(parsed.format);
    if (!destination) return { cancelled: true };
    const result = await requireClient().export(parsed, destination); return { cancelled: false, path: destination, ...result };
  });
  handle("launcher:diagnostics-copy", async (_event, input) => {
    const parsed = input && typeof input === "object" && "selection" in input ? CopyOptionsSchema.parse(input) : CopyOptionsSchema.parse({ format: "json", selection: { kind: "results", query: QuerySchema.parse(input) } });
    const result = await requireClient().copy(parsed);
    options.copyText(result.text);
    return { records: result.records, incomplete: result.incomplete };
  });
  handle("launcher:diagnostics-review-setup", async (_event, input) => {
    const traceId = TraceIdSchema.parse(input);
    const evidence = await requireClient().query({ traceId, ascending: true, limit: 200 });
    // Only this demonstrated recovery route is reconstructible without credentials or lost setup choices.
    if (!options.reviewUpgrade || !evidence.events.some(event => event.kind === "span" && event.component === "launcher" && event.name === "runtime-upgrade")) throw new DiagnosticRequestError("recovery_unavailable");
    await options.reviewUpgrade(); return { ok: true };
  });
}

export function registerLoggedIpc(ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => void }, logger: Pick<DiagnosticLogger, "error"> & Partial<Pick<DiagnosticLogger, "operation">>, channel: string, handler: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, async (...args) => {
    try {
      // Query traffic is not recorded as new operations, preventing a self-observation loop.
      return logger.operation && !/diagnostics-|snapshot|logs|browser-bounds|window-state/.test(channel) ? await logger.operation(channel.replace("launcher:", ""), async () => handler(...args)) : await handler(...args);
    } catch (error) {
      if (isDiagnosticCancellation(error)) return requestFailure(error, "cancelled");
      logger.error("launcher.ipc_failed", { channel }); throw error;
    }
  });
}

/** Minimal bounded bootstrap fallback; retained only when the diagnostics worker cannot exist yet. */
export function installProcessDiagnosticGuards({ filePath, streams = [process.stdout, process.stderr] }: { filePath: string; streams?: Writable[] }) {
  for (const stream of new Set(streams)) stream.on("error", () => {
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      if (existsSync(filePath) && statSync(filePath).size >= 64 * 1024) writeFileSync(filePath, "", { mode: 0o600 });
      appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), level: "error", event: "process.stream_failed", detail: { message: "A process diagnostic stream failed; raw output omitted" } })}\n`, { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(filePath, 0o600);
    } catch { /* No recursive logging when the bootstrap sink is unavailable. */ }
  });
}
