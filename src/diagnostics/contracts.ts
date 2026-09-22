import { z } from "zod";
import { diagnosticRequestMessages, DiagnosticFailureDetailsSchema, DiagnosticWritePhaseSchema, type DiagnosticRequestCode } from "./request-error";
export { DiagnosticWritePhaseSchema } from "./request-error";

export const DIAGNOSTIC_VERSION = 1 as const;
export const DEFAULT_RETENTION = Object.freeze({ days: 14, bytes: 64 * 1024 * 1024, debugMs: 30 * 60_000, privateMs: 24 * 60 * 60_000, privateBytes: 128 * 1024 * 1024 });
export const SeveritySchema = z.enum(["debug", "info", "warning", "error"]);
export const OutcomeSchema = z.enum(["running", "succeeded", "failed", "cancelled", "interrupted", "recovered", "unknown"]);
export const TraceIdSchema = z.string().regex(/^[a-f0-9]{32}$/).refine(value => !/^0+$/.test(value));
export const SpanIdSchema = z.string().regex(/^[a-f0-9]{16}$/).refine(value => !/^0+$/.test(value));
export const DiagnosticRequestIdSchema = z.string().uuid();
export const RecoveryActionSchema = z.enum(["run-doctor", "review-configuration", "review-setup", "export-logs", "open-diagnostics"]);
const ShortText = z.string().max(4096);
export const ProblemSchema = z.object({
  version: z.literal(1).default(1),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
  message: ShortText,
  stage: z.string().max(160).optional(),
  traceId: TraceIdSchema.optional(),
  spanId: SpanIdSchema.optional(),
  findings: z.array(z.object({ path: ShortText.optional(), message: ShortText })).max(512).default([]),
  causes: z.array(z.object({ code: z.string().max(96), message: ShortText })).max(8).default([]),
  actions: z.array(RecoveryActionSchema).max(5).default(["run-doctor", "export-logs"]),
  recovery: z.enum(["not-needed", "not-started", "completed", "incomplete", "unknown"]).default("unknown"),
  exitCode: z.number().int().optional(),
  signal: z.string().max(32).nullable().optional(),
  origin: z.string().max(96).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  retryable: z.boolean().optional(),
  stack: ShortText.optional(),
  evidenceMissing: ShortText.optional(),
}).strict();
export type Problem = z.infer<typeof ProblemSchema>;

const AttributeValueSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.array(z.union([z.string().max(512), z.number().finite(), z.boolean()])).max(64)]);
export const AttributesSchema = z.record(z.string().max(160), AttributeValueSchema).refine(value => Object.keys(value).length <= 64, "Too many attributes");
export const SpanEvidenceSchema = z.discriminatedUnion("outcome", [
  z.object({ startTime: z.number().nonnegative(), outcome: z.literal("running"), endTime: z.undefined().optional() }).strict(),
  z.object({ startTime: z.number().nonnegative(), endTime: z.number().nonnegative(), outcome: OutcomeSchema.exclude(["running"]) }).strict(),
]);
const EventFields = {
  version: z.literal(1), id: z.string().uuid(), time: z.number().finite().nonnegative(),
  name: z.string().min(1).max(160), severity: SeveritySchema,
  body: z.string().max(4096), component: z.string().min(1).max(96),
  environment: z.enum(["production", "development", "test"]), target: z.string().min(1).max(256),
  traceId: TraceIdSchema.optional(), spanId: SpanIdSchema.optional(), parentSpanId: SpanIdSchema.optional(),
  taskId: z.string().max(256).optional(), taskName: z.string().max(256).optional(),
  attributes: AttributesSchema.default({}),
};
export const DiagnosticEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...EventFields, kind: z.literal("span"), traceId: TraceIdSchema, spanId: SpanIdSchema, span: SpanEvidenceSchema, problem: z.undefined().optional() }).strict(),
  z.object({ ...EventFields, kind: z.literal("problem"), problem: ProblemSchema, span: z.undefined().optional() }).strict(),
  z.object({ ...EventFields, kind: z.enum(["log", "lifecycle"]), span: z.undefined().optional(), problem: z.undefined().optional() }).strict(),
]).refine(event => !event.spanId || Boolean(event.traceId), "A span requires a trace");
export type DiagnosticEvent = z.infer<typeof DiagnosticEventSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export const QuerySchema = z.object({
  view: z.enum(["events", "operations", "problems", "overview", "groups", "occurrences"]).default("events"),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.string().max(512).optional(),
  eventId: z.string().uuid().optional(),
  groupKey: z.string().max(16384).optional(),
  snapshotSequence: z.number().int().nonnegative().optional(),
  traceId: TraceIdSchema.optional(), taskId: z.string().max(256).optional(),
  target: z.string().max(256).optional(), component: z.string().max(96).optional(),
  severity: SeveritySchema.optional(), outcome: OutcomeSchema.optional(),
  eventIds: z.array(z.string().uuid()).max(1000).optional(),
  traceIds: z.array(TraceIdSchema).max(1000).optional(),
  targets: z.array(z.string().max(256)).max(64).optional(),
  components: z.array(z.string().max(96)).max(64).optional(),
  severities: z.array(SeveritySchema).max(4).optional(),
  outcomes: z.array(OutcomeSchema).max(7).optional(),
  kinds: z.array(z.enum(["span", "problem", "log", "lifecycle"])).max(4).optional(),
  operationTypes: z.array(z.enum(["operation", "service"])).max(2).optional(),
  exitCodes: z.array(z.number().int()).max(64).optional(),
  signals: z.array(z.string().max(32)).max(64).optional(),
  from: z.number().nonnegative().optional(), to: z.number().nonnegative().optional(),
  text: z.string().max(512).optional(), regex: z.string().max(256).optional(),
  ascending: z.boolean().default(false),
  follow: z.boolean().optional(),
}).strict().refine(query => query.from === undefined || query.to === undefined || query.from <= query.to, "Start time must not be after end time")
  .refine(query => query.view !== "occurrences" || Boolean(query.groupKey), "Choose a problem group");
export type DiagnosticQuery = z.input<typeof QuerySchema>;
export const QueryResultSchema = z.object({
  version: z.literal(1), events: z.array(DiagnosticEventSchema).max(200),
  nextCursor: z.string().optional(), incomplete: z.boolean(), notices: z.array(z.string()),
  followCursor: z.string().optional(),
  snapshotSequence: z.number().int().nonnegative().optional(),
  groups: z.array(z.object({ key: z.string(), eventId: z.string().uuid(), occurrences: z.number().int().positive(), firstTime: z.number(), lastTime: z.number() })).optional(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;
export const CaptureStateSchema = z.object({
  debugUntil: z.number().nonnegative().default(0),
  privateUntil: z.number().nonnegative().default(0),
  privateScope: z.string().max(256).default(""),
});
export type CaptureState = z.infer<typeof CaptureStateSchema>;
export const CaptureCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("debug-start") }).strict(),
  z.object({ action: z.literal("debug-stop") }).strict(),
  z.object({ action: z.literal("private-start"), scope: z.union([z.literal("next-browser-turn"), TraceIdSchema]), acknowledged: z.literal(true) }).strict(),
  z.object({ action: z.literal("private-stop") }).strict(),
]);
export type CaptureCommand = z.infer<typeof CaptureCommandSchema>;
export const MAX_CAPTURE_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const CAPTURE_DOCUMENT_PART_CHARS = 256 * 1024;
const ContentCategorySchema = z.enum(["prompt", "output", "tool-arguments", "tool-result", "browser-state", "transport", "oracle", "screenshot"]);
const DocumentIdentity = { campaignId: z.string().uuid(), traceId: TraceIdSchema, documentId: z.string().uuid() };
export const ContentCaptureCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), campaignId: z.string().uuid(), acknowledged: z.literal(true), until: z.number().int().positive(), maxBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).default(512 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal("bind"), campaignId: z.string().uuid(), traceId: TraceIdSchema }).strict(),
  z.object({ action: z.literal("finish"), campaignId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("write"), campaignId: z.string().uuid(), traceId: TraceIdSchema, category: ContentCategorySchema, text: z.string().max(1024 * 1024) }).strict(),
  z.object({ action: z.literal("document-start"), ...DocumentIdentity, category: ContentCategorySchema.exclude(["screenshot"]), bytes: z.number().int().nonnegative().max(MAX_CAPTURE_DOCUMENT_BYTES) }).strict(),
  z.object({ action: z.literal("document-part"), ...DocumentIdentity, index: z.number().int().nonnegative().max(4095), text: z.string().max(CAPTURE_DOCUMENT_PART_CHARS) }).strict(),
  z.object({ action: z.literal("document-finish"), ...DocumentIdentity }).strict(),
  z.object({ action: z.literal("document-abort"), ...DocumentIdentity }).strict(),
  z.object({ action: z.literal("omit"), campaignId: z.string().uuid(), traceId: TraceIdSchema, reason: z.enum(["authentication-content", "storage-budget", "attachment-limit", "invalid-image", "too-large", "surface-excluded", "capture-failed"]) }).strict(),
  z.object({ action: z.literal("manifest"), campaignId: z.string().uuid() }).strict(),
]);
export type ContentCaptureCommand = z.input<typeof ContentCaptureCommandSchema>;
export const CaptureCollectionWindowSchema = z.object({
  startSequence: z.number().int().nonnegative(), startDropped: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative().nullable(), endDropped: z.number().int().nonnegative().nullable(),
  currentDropped: z.number().int().nonnegative(),
}).strict();
export type CaptureCollectionWindow = z.infer<typeof CaptureCollectionWindowSchema>;
/** Counts describe reports within observed boundaries, never unreported loss or task success. */
export function reportedCaptureDrops(window: CaptureCollectionWindow | null | undefined): number | null {
  if (!CaptureCollectionWindowSchema.safeParse(window).success || !window || (window.endSequence === null) !== (window.endDropped === null)) return null;
  const end = window.endDropped ?? window.currentDropped;
  if (end < window.startDropped || window.currentDropped < end || window.endSequence !== null && window.endSequence < window.startSequence) return null;
  return end - window.startDropped;
}
export const ContentManifestSchema = z.object({ collectionWindow: CaptureCollectionWindowSchema.nullable().default(null), campaignId: z.string().uuid(), deadline: z.number(), finished: z.number().int().min(0).max(1), omitted: z.number().int().nonnegative(), maxBytes: z.number().int().positive(), collectionFailures: z.number().int().nonnegative().default(0), traceIds: z.array(TraceIdSchema).max(1000), attachments: z.array(z.object({ id: z.string().uuid(), traceId: TraceIdSchema, category: z.string().max(64), time: z.number(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), document: z.object({ id: z.string().uuid(), index: z.number().int().nonnegative() }).optional() })).max(10000), documents: z.array(z.object({ id: z.string().uuid(), traceId: TraceIdSchema, category: z.string().max(64), status: z.enum(["receiving", "stored", "omitted"]), inputBytes: z.number().int().nonnegative(), bytes: z.number().int().nonnegative().nullable(), chunks: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() })).max(10000).default([]) });
export const ContentCaptureResultSchema = z.union([
  ContentManifestSchema,
  z.object({ campaignId: z.string().uuid(), until: z.number(), maxBytes: z.number() }),
  z.object({ bound: z.literal(true) }), z.object({ finished: z.literal(true) }),
  z.object({ status: z.literal("stored"), id: z.string().uuid(), bytes: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ status: z.literal("receiving"), documentId: z.string().uuid(), nextIndex: z.number().int().nonnegative() }),
  z.object({ status: z.literal("stored-document"), documentId: z.string().uuid(), chunks: z.number().int().positive(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ status: z.literal("omitted"), reason: z.enum(["authentication-content", "storage-budget", "attachment-limit", "invalid-image", "too-large", "surface-excluded", "capture-failed", "unsupported-content"]) }),
]);
export const CaptureWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stored"), id: z.string().uuid(), expires: z.number() }),
  z.object({ status: z.literal("omitted"), reason: z.enum(["inactive", "too-large", "invalid-image", "storage-unavailable"]) }),
]);
export type CaptureWriteResult = z.infer<typeof CaptureWriteResultSchema>;
export const WorkerInvocationSchema = z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(32), cwd: z.string().max(4096).optional() }).strict();
export const StatusSchema = z.object({
  version: z.literal(1), available: z.boolean(), schemaVersion: z.number(),
  eventCount: z.number(), operationCount: z.number(), problemCount: z.number(),
  lastSequence: z.number().nonnegative().optional(),
  bytes: z.number(), privateBytes: z.number(), dropped: z.number(),
  content: z.object({ campaigns: z.number().int().nonnegative(), active: z.number().int().nonnegative(), bytes: z.number().int().nonnegative(), omitted: z.number().int().nonnegative() }).optional(),
  oldestTime: z.number().nullable(), newestTime: z.number().nullable(),
  captures: CaptureStateSchema, retention: z.object({ days: z.number(), bytes: z.number(), privateMs: z.number(), privateBytes: z.number() }),
  components: z.array(z.string()), targets: z.array(z.string()), notices: z.array(z.string()),
  runtime: z.object({ state: z.enum(["healthy", "unavailable", "unconfigured", "unknown"]), checkedAt: z.number().nonnegative() }).optional(),
});
export type DiagnosticStatus = z.infer<typeof StatusSchema>;
export const ReportSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), eventIds: z.array(z.string().uuid()).max(1000).default([]), traceIds: z.array(TraceIdSchema).max(1000).default([]), snapshotSequence: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("event"), eventId: z.string().uuid(), snapshotSequence: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("operation"), traceId: TraceIdSchema, snapshotSequence: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("results"), query: QuerySchema }).strict(),
  z.object({ kind: z.literal("all"), snapshotSequence: z.number().int().nonnegative().optional() }).strict(),
]);
export type ReportSelection = z.input<typeof ReportSelectionSchema>;
export const ExportOptionsSchema = z.object({ format: z.enum(["bundle", "html", "json", "otlp"]).default("bundle"), query: QuerySchema.default(() => QuerySchema.parse({})), selection: ReportSelectionSchema.optional(), content: z.object({ campaignId: z.string().uuid(), acknowledged: z.literal(true) }).strict().optional() }).strict();
export type ExportOptions = z.input<typeof ExportOptionsSchema>;
export const CopyOptionsSchema = z.object({ format: z.enum(["summary", "json"]).default("summary"), selection: ReportSelectionSchema }).strict();
export type CopyOptions = z.input<typeof CopyOptionsSchema>;
export const ReportResultSchema = z.object({ records: z.number().int().nonnegative(), incomplete: z.boolean(), files: z.number().int().nonnegative().optional() });
export const CopyReportSchema = ReportResultSchema.extend({ text: z.string().max(1_500_000), notices: z.array(z.string()) });
export interface DiagnosticsApi {
  status(): Promise<DiagnosticStatus>;
  query(query: DiagnosticQuery, requestId?: string): Promise<QueryResult>;
  cancelQuery(requestId: string): Promise<void>;
  capture(command: CaptureCommand): Promise<CaptureState>;
  clear(scope: "normal" | "private", confirmed: boolean): Promise<DiagnosticStatus>;
  export(options: ExportOptions): Promise<{ cancelled: boolean; path?: string; records?: number; files?: number; incomplete?: boolean }>;
  copy(options: CopyOptions | DiagnosticQuery): Promise<{ records: number; incomplete: boolean } | void>;
  reviewSetup?(traceId: string): Promise<{ ok: boolean }>;
  subscribe(listener: () => void): () => void;
}

export const WorkerRequestSchema = z.discriminatedUnion("method", [
  z.object({ id: z.string().max(96), method: z.literal("content-capture"), command: ContentCaptureCommandSchema }),
  z.object({ id: z.string().max(96), method: z.literal("append"), events: z.array(DiagnosticEventSchema).max(128) }),
  z.object({ id: z.string().max(96), method: z.literal("query"), query: QuerySchema }),
  z.object({ id: z.string().max(96), method: z.literal("cancel"), requestId: z.string().max(96) }),
  z.object({ id: z.string().max(96), method: z.literal("status") }),
  z.object({ id: z.string().max(96), method: z.literal("capture"), command: CaptureCommandSchema }),
  z.object({ id: z.string().max(96), method: z.literal("capture-status") }),
  z.object({ id: z.string().max(96), method: z.literal("capture-claim"), traceId: TraceIdSchema }),
  z.object({ id: z.string().max(96), method: z.literal("capture-write"), traceId: TraceIdSchema, png: z.string().max(1_400_000) }),
  z.object({ id: z.string().max(96), method: z.literal("clear"), scope: z.enum(["normal", "private"]), confirmed: z.literal(true) }),
  z.object({ id: z.string().max(96), method: z.literal("export"), options: ExportOptionsSchema, destination: z.string().max(4096) }),
  z.object({ id: z.string().max(96), method: z.literal("copy"), options: CopyOptionsSchema }),
  z.object({ id: z.string().max(96), method: z.literal("import"), files: z.array(z.string().max(4096)).max(8) }),
  z.object({ id: z.string().max(96), method: z.literal("dropped"), count: z.number().int().positive().max(1_000_000) }),
  z.object({ id: z.string().max(96), method: z.literal("close") }),
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export const WorkerRequestStartedSchema = z.object({ event: z.literal("worker-request-started"), id: z.string().max(96), method: z.enum(WorkerRequestSchema.options.map(option => option.shape.method.value) as [WorkerRequest["method"], ...WorkerRequest["method"][]]) }).strict();
export type DiagnosticWritePhase = z.infer<typeof DiagnosticWritePhaseSchema>;
export const WorkerRequestProgressSchema = z.object({ event: z.literal("worker-request-progress"), id: z.string().max(96), method: z.enum(["append", "content-capture"]), phase: DiagnosticWritePhaseSchema }).strict();
export const WorkerTerminationSchema = z.object({ event: z.literal("worker-stopping"), reason: z.enum(["request-close", "input-ended", "input-error", "input-closed", "input-too-large", "output-backpressure", "SIGTERM", "SIGINT"]) }).strict();
export type WorkerTerminationReason = z.infer<typeof WorkerTerminationSchema>["reason"];
export const DiagnosticRequestCodeSchema = z.enum(Object.keys(diagnosticRequestMessages) as [DiagnosticRequestCode, ...DiagnosticRequestCode[]]);
export const WorkerStartupFailureSchema = z.object({ event: z.literal("worker-startup-failed"), code: DiagnosticRequestCodeSchema, details: DiagnosticFailureDetailsSchema.optional() }).strict();
export const WorkerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string().max(96), ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: z.string().max(96), ok: z.literal(false), error: z.string().max(512), code: DiagnosticRequestCodeSchema.optional(), details: DiagnosticFailureDetailsSchema.optional() }).strict(),
]);

export function unavailableStatus(notice: string): DiagnosticStatus {
  return { version: 1, available: false, schemaVersion: 0, eventCount: 0, operationCount: 0, problemCount: 0, bytes: 0, privateBytes: 0, dropped: 0, oldestTime: null, newestTime: null, captures: { debugUntil: 0, privateUntil: 0, privateScope: "" }, retention: DEFAULT_RETENTION, components: [], targets: [], notices: [notice] };
}
