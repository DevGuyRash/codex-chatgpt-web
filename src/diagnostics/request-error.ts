export const diagnosticRequestMessages = {
  cancelled: "Diagnostic request cancelled",
  timeout: "The diagnostic search exceeded its time limit; narrow the query and try again",
  invalid_query: "The search is invalid; check the regular expression and filters",
  query_failed: "The diagnostic query could not finish; check collection status and try again",
  busy: "Diagnostics is busy; wait for the current request to finish",
  unavailable: "Diagnostic storage is unavailable; check permissions, free space, and component versions",
  recovery_unavailable: "The original setup choices cannot be reconstructed from retained evidence. Open Setup to review the intended connection; no setup changes were started.",
  export_failed: "The report could not be saved; check the destination and free space",
  capture_failed: "Capture settings could not be changed; the last known state is still shown",
  clear_failed: "Diagnostic records could not be cleared; inspect collection status",
} as const;
export type DiagnosticRequestCode = keyof typeof diagnosticRequestMessages;
export type DiagnosticFailure = { diagnosticFailure: true; code: DiagnosticRequestCode };
/** Plain results cross both IPC and contextBridge before the renderer recreates typed errors. */
export type DiagnosticsBridgeApi = {
  [K in keyof DiagnosticsApi]: NonNullable<DiagnosticsApi[K]> extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R | DiagnosticFailure> : DiagnosticsApi[K];
};
export class DiagnosticRequestError extends Error {
  constructor(readonly code: DiagnosticRequestCode) { super(diagnosticRequestMessages[code]); this.name = code === "cancelled" ? "AbortError" : "DiagnosticRequestError"; }
}
export function diagnosticRequestCode(error: unknown, fallback: DiagnosticRequestCode): DiagnosticRequestCode {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && Object.hasOwn(diagnosticRequestMessages, error.code)) return error.code as DiagnosticRequestCode;
  return fallback;
}

/** Electron preserves plain return values, but strips custom properties from thrown Errors. */
export function requestFailure(error: unknown, fallback: DiagnosticRequestCode) {
  return { diagnosticFailure: true as const, code: error instanceof Error && error.name === "ZodError" ? "invalid_query" as const : diagnosticRequestCode(error, fallback) };
}
export function unwrapDiagnosticResult<T>(value: T): T {
  if (value && typeof value === "object" && "diagnosticFailure" in value && value.diagnosticFailure === true) throw new DiagnosticRequestError(diagnosticRequestCode(value, "unavailable"));
  return value;
}
import type { DiagnosticsApi } from "./contracts";
