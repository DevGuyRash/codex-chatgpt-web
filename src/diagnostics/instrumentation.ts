import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ROOT_CONTEXT, trace, SpanStatusCode, TraceFlags, type Attributes, type Span } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { BasicTracerProvider, SimpleSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { LoggerProvider, SimpleLogRecordProcessor, type ReadableLogRecord, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { TraceIdSchema, SpanIdSchema, type DiagnosticEvent, type Severity, type Outcome, type Problem } from "./contracts";
import { safeAttributes, safeText, sanitizeEvent } from "./privacy";
import { problemFor } from "./problems";
import { isDiagnosticCancellation } from "./outcome";

export interface DiagnosticSink { emit(event: DiagnosticEvent): void; flush?(): Promise<void>; }
export interface DiagnosticContext { traceId: string; spanId: string; taskId?: string; taskName?: string; }
export interface Operation {
  context: DiagnosticContext;
  identify(task: { id?: string; name?: string }): void;
  end(outcome?: Exclude<Outcome, "running">, attributes?: Record<string, unknown>): void;
  problem(error: unknown, message?: string, extra?: Partial<Problem>): Problem;
  run<T>(action: () => T): T;
}
const timeMs = (time: readonly [number, number]) => time[0] * 1000 + time[1] / 1_000_000;
const otelAttributes = (input: unknown): Attributes => Object.fromEntries(Object.entries(safeAttributes(input)).map(([key, value]) => [key, Array.isArray(value) ? value.map(String) : value]));

/** Explicit OpenTelemetry providers avoid global SDK registration and remote exporters. */
export class Diagnostics {
  private readonly current = new AsyncLocalStorage<DiagnosticContext>();
  private readonly tracerProvider: BasicTracerProvider;
  private readonly logProvider: LoggerProvider;
  private readonly tracer;
  private readonly logger;
  private readonly base: Pick<DiagnosticEvent, "component" | "environment" | "target">;
  private readonly serviceVersion: string;
  private readonly active = new Set<Operation>();
  private readonly taskNames = new Map<string, string>();
  constructor(private readonly sink: DiagnosticSink, options: { component: string; environment: DiagnosticEvent["environment"]; target: string; version?: string; debugEnabled?: () => boolean }) {
    this.base = { component: options.component, environment: options.environment, target: options.target };
    this.serviceVersion = options.version ?? "unknown";
    const resource = resourceFromAttributes({ "service.name": `codex-web-gpt.${options.component}`, "service.version": options.version ?? "unknown", "deployment.environment.name": options.environment });
    const emit = (event: DiagnosticEvent) => { try { this.sink.emit(sanitizeEvent(event)); } catch { /* Telemetry cannot change application outcomes. Sink health reports collection loss. */ } };
    const spanExporter: SpanExporter = {
      export: (spans: ReadableSpan[], done: (result: ExportResult) => void) => {
        for (const span of spans) {
          const context = span.spanContext();
          const taskName = this.taskNames.get(context.spanId);
          this.taskNames.delete(context.spanId);
          const outcome = span.attributes["diagnostics.outcome"];
          emit({ version: 1, id: randomUUID(), time: timeMs(span.endTime), kind: "span", name: span.name.slice(0, 160), severity: outcome === "failed" ? "error" : "info", body: `${span.name}: ${String(outcome ?? "unknown")}`, ...this.base,
            traceId: context.traceId, spanId: context.spanId, parentSpanId: span.parentSpanContext?.spanId,
            taskId: typeof span.attributes["diagnostics.task_id"] === "string" ? span.attributes["diagnostics.task_id"] : undefined,
            taskName,
            attributes: safeAttributes({ ...span.attributes, "service.version": options.version ?? "unknown" }),
            span: { startTime: timeMs(span.startTime), endTime: timeMs(span.endTime), outcome: ["succeeded", "failed", "cancelled", "interrupted", "recovered", "unknown"].includes(String(outcome)) ? outcome as Exclude<Outcome, "running"> : "unknown" },
          });
        }
        done({ code: ExportResultCode.SUCCESS });
      }, shutdown: async () => {}, forceFlush: async () => {},
    };
    const logExporter: LogRecordExporter = {
      export: (logs: ReadableLogRecord[], done: (result: ExportResult) => void) => {
        for (const log of logs) emit({ version: 1, id: randomUUID(), time: timeMs(log.hrTime), kind: "log", name: (log.eventName ?? "event").slice(0, 160), severity: (log.severityText ?? "info") as Severity,
          body: safeText(typeof log.body === "string" ? log.body : "Diagnostic event"), ...this.base,
          traceId: log.spanContext?.traceId, spanId: log.spanContext?.spanId,
          taskId: typeof log.attributes["diagnostics.task_id"] === "string" ? log.attributes["diagnostics.task_id"] : undefined,
          attributes: safeAttributes({ ...log.attributes, "service.version": options.version ?? "unknown" }),
        });
        done({ code: ExportResultCode.SUCCESS });
      }, shutdown: async () => {}, forceFlush: async () => {},
    };
    this.tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(spanExporter)], spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 4096 } });
    this.logProvider = new LoggerProvider({ resource, processors: [new SimpleLogRecordProcessor({ exporter: logExporter })], logRecordLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 4096 } });
    this.tracer = this.tracerProvider.getTracer("codex-web-gpt.diagnostics", "1");
    this.logger = this.logProvider.getLogger("codex-web-gpt.diagnostics", "1");
    this.debugEnabled = options.debugEnabled ?? (() => false);
  }
  private readonly debugEnabled: () => boolean;
  context(): DiagnosticContext | undefined { return this.current.getStore(); }
  ingest(event: unknown): void {
    try { this.sink.emit(sanitizeEvent(event)); } catch { /* Untrusted producer records cannot affect task execution. */ }
  }
  withContext<T>(context: DiagnosticContext, action: () => T): T { return this.current.run(context, action); }
  event(name: string, body: string, attributes: Record<string, unknown> = {}, severity: Severity = "info", suppliedContext?: DiagnosticContext): void {
    if (severity === "debug" && !this.debugEnabled()) return;
    const current = suppliedContext ?? this.context();
    const context = current ? trace.setSpanContext(ROOT_CONTEXT, { ...current, traceFlags: TraceFlags.SAMPLED }) : ROOT_CONTEXT;
    this.logger.emit({ eventName: name.slice(0, 160), body: safeText(body), severityText: severity,
      severityNumber: { debug: SeverityNumber.DEBUG, info: SeverityNumber.INFO, warning: SeverityNumber.WARN, error: SeverityNumber.ERROR }[severity],
      attributes: safeAttributes({ ...attributes, ...(current?.taskId ? { "diagnostics.task_id": current.taskId } : {}) }), context });
  }
  begin(name: string, attributes: Record<string, unknown> = {}, parent: DiagnosticContext | null | undefined = this.context(), task?: { id?: string; name?: string }): Operation {
    const parentContext = parent ? trace.setSpanContext(ROOT_CONTEXT, { ...parent, traceFlags: TraceFlags.SAMPLED }) : ROOT_CONTEXT;
    const span: Span = this.tracer.startSpan(name.slice(0, 160), { attributes: otelAttributes({ ...attributes, ...(task?.id ?? parent?.taskId ? { "diagnostics.task_id": task?.id ?? parent?.taskId } : {}) }) }, parentContext);
    const context: DiagnosticContext = { traceId: span.spanContext().traceId, spanId: span.spanContext().spanId, taskId: task?.id ?? parent?.taskId, taskName: task?.name ?? parent?.taskName };
    if (context.taskName) this.taskNames.set(context.spanId, context.taskName);
    const startTime = Date.now(); let ended = false, observedFailure = false;
    try { this.sink.emit(sanitizeEvent({ version: 1, id: randomUUID(), time: startTime, kind: "span", name: name.slice(0, 160), severity: "info", body: `${name}: started`, ...this.base, ...context,
      parentSpanId: parent?.spanId, attributes: safeAttributes({ ...attributes, "service.version": this.serviceVersion }), span: { startTime, outcome: "running" } })); } catch { /* Diagnostics never owns application outcomes. */ }
    const operation: Operation = {
      context,
      identify: task => {
        if (ended) return;
        if (task.id) { context.taskId = task.id.slice(0, 256); span.setAttribute("diagnostics.task_id", context.taskId); }
        if (task.name) { context.taskName = safeText(task.name).slice(0, 256); this.taskNames.set(context.spanId, context.taskName); }
      },
      run: action => this.current.run(context, action),
      end: (outcome = "succeeded", detail = {}) => {
        if (ended) return; ended = true; this.active.delete(operation);
        if (observedFailure && (outcome === "succeeded" || outcome === "cancelled")) outcome = "failed";
        span.setAttributes(otelAttributes({ ...detail, "diagnostics.outcome": outcome }));
        span.setStatus({ code: outcome === "failed" ? SpanStatusCode.ERROR : outcome === "succeeded" || outcome === "recovered" ? SpanStatusCode.OK : SpanStatusCode.UNSET }); span.end();
      },
      problem: (error, message, extra = {}) => {
        observedFailure = true;
        const problem = problemFor(error, message, { traceId: context.traceId, spanId: context.spanId, stage: name.slice(0, 160), ...extra });
        try { this.sink.emit(sanitizeEvent({ version: 1, id: randomUUID(), time: Date.now(), kind: "problem", name: problem.code, severity: "error", body: problem.message, ...this.base, ...context, attributes: { "service.version": this.serviceVersion }, problem })); } catch { /* Diagnostics never owns application outcomes. */ }
        return problem;
      },
    };
    this.active.add(operation); return operation;
  }
  async run<T>(name: string, action: (operation: Operation) => Promise<T>, attributes: Record<string, unknown> = {}): Promise<T> {
    const operation = this.begin(name, attributes);
    return operation.run(async () => {
      try { const result = await action(operation); operation.end(); return result; }
      catch (error) {
        const cancelled = isDiagnosticCancellation(error);
        if (!cancelled) operation.problem(error);
        operation.end(cancelled ? "cancelled" : "failed");
        throw error;
      }
    });
  }
  async close(): Promise<void> {
    for (const operation of this.active) operation.end("interrupted");
    await this.tracerProvider.shutdown(); await this.logProvider.shutdown(); await this.sink.flush?.();
  }
}

export function parseTraceparent(value: string | undefined): DiagnosticContext | undefined {
  if (!value) return undefined;
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-0[01]$/.exec(value);
  if (!match || !TraceIdSchema.safeParse(match[1]).success || !SpanIdSchema.safeParse(match[2]).success) return undefined;
  return { traceId: match[1], spanId: match[2] };
}
export function traceparent(context: DiagnosticContext | undefined): string | undefined { return context ? `00-${context.traceId}-${context.spanId}-01` : undefined; }
