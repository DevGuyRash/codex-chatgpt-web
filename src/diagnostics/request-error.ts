import { z } from "zod";

export const DiagnosticWritePhaseSchema = z.enum(["startup", "validation", "transaction", "commit", "retention"]);

// Only bounded, payload-free observations may cross the worker and Electron boundaries.
export const DiagnosticFailureDetailsSchema = z.object({
  method: z.string().regex(/^[a-z-]{1,32}$/).optional(),
  action: z.string().regex(/^[a-z-]{1,32}$/).optional(),
  phase: DiagnosticWritePhaseSchema.optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  workerElapsedMs: z.number().int().nonnegative().optional(),
  inputBytes: z.number().int().nonnegative().optional(),
  inputWriteCompleted: z.boolean().optional(),
  inputWrittenAfterMs: z.number().int().nonnegative().optional(),
  inputBufferedBytes: z.number().int().nonnegative().optional(),
  maxEventLoopLagMs: z.number().int().nonnegative().optional(),
  parentCpuMs: z.number().int().nonnegative().optional(),
  sqliteCode: z.enum(["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_TIMEOUT", "SQLITE_LOCKED", "SQLITE_LOCKED_SHAREDCACHE", "SQLITE_LOCKED_VTAB"]).optional(),
  sqliteErrno: z.number().int().nonnegative().max(65535).optional(),
}).strict();
export type DiagnosticFailureDetails = z.infer<typeof DiagnosticFailureDetailsSchema>;
export function sqliteFailureDetails(error: unknown): DiagnosticFailureDetails | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  const code = DiagnosticFailureDetailsSchema.shape.sqliteCode.safeParse(error.code);
  if (!code.success || code.data === undefined) return;
  const errno = DiagnosticFailureDetailsSchema.shape.sqliteErrno.safeParse("errno" in error ? error.errno : undefined);
  return { sqliteCode: code.data, ...(errno.success && errno.data !== undefined ? { sqliteErrno: errno.data } : {}) };
}

export const diagnosticRequestMessages = {
  cancelled: "Diagnostic request cancelled",
  timeout: "The diagnostic request exceeded its time limit; inspect collection status before retrying",
  invalid_query: "The search is invalid; check the regular expression and filters",
  query_failed: "The diagnostic query could not finish; check collection status and try again",
  busy: "Diagnostics is busy; wait for the current request to finish",
  storage_busy: "Diagnostic storage rejected the request because a database lock was unavailable",
  storage_snapshot_conflict: "Diagnostic storage could not promote an older transaction snapshot to a write",
  invalid_request: "The diagnostic request does not match the worker's input contract",
  unavailable: "Diagnostic storage is unavailable; check permissions, free space, and component versions",
  recovery_unavailable: "The original setup choices cannot be reconstructed from retained evidence. Open Setup to review the intended connection; no setup changes were started.",
  export_failed: "The report could not be saved; check the destination and free space",
  capture_failed: "Capture settings could not be changed; the last known state is still shown",
  clear_failed: "Diagnostic records could not be cleared; inspect collection status",
} as const;
export type DiagnosticRequestCode = keyof typeof diagnosticRequestMessages;
export type DiagnosticFailure = { diagnosticFailure: true; code: DiagnosticRequestCode; details?: DiagnosticFailureDetails };
/** Plain results cross both IPC and contextBridge before the renderer recreates typed errors. */
export type DiagnosticsBridgeApi = {
  [K in keyof DiagnosticsApi]: NonNullable<DiagnosticsApi[K]> extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R | DiagnosticFailure> : DiagnosticsApi[K];
};
export class DiagnosticRequestError extends Error {
  readonly details?: DiagnosticFailureDetails;
  constructor(readonly code: DiagnosticRequestCode, details?: DiagnosticFailureDetails) { super(diagnosticRequestMessages[code]); this.name = code === "cancelled" ? "AbortError" : "DiagnosticRequestError"; const parsed = DiagnosticFailureDetailsSchema.safeParse(details); this.details = parsed.success ? parsed.data : undefined; }
}
export function diagnosticRequestCode(error: unknown, fallback: DiagnosticRequestCode): DiagnosticRequestCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "ZodError") return "invalid_request";
  const sqlite = sqliteFailureDetails(error);
  if (sqlite) return sqlite.sqliteCode === "SQLITE_BUSY_SNAPSHOT" || sqlite.sqliteErrno === 517 ? "storage_snapshot_conflict" : "storage_busy";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && Object.hasOwn(diagnosticRequestMessages, error.code)) return error.code as DiagnosticRequestCode;
  return fallback;
}

/** Electron preserves plain return values, but strips custom properties from thrown Errors. */
export function requestFailure(error: unknown, fallback: DiagnosticRequestCode) {
  return { diagnosticFailure: true as const, code: error instanceof Error && error.name === "ZodError" ? "invalid_query" as const : diagnosticRequestCode(error, fallback), ...(error instanceof DiagnosticRequestError && error.details ? { details: error.details } : {}) };
}
export function unwrapDiagnosticResult<T>(value: T): T {
  if (value && typeof value === "object" && "diagnosticFailure" in value && value.diagnosticFailure === true) {
    const details = DiagnosticFailureDetailsSchema.safeParse("details" in value ? value.details : undefined);
    throw new DiagnosticRequestError(diagnosticRequestCode(value, "unavailable"), details.success ? details.data : undefined);
  }
  return value;
}
import type { DiagnosticsApi } from "./contracts";
