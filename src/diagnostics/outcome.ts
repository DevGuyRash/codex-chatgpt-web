import type { Outcome } from "./contracts";

export function diagnosticCancellation(message = "Operation cancelled") {
  return Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
}

/** Cancellation is evidence from an owner, never inferred from arbitrary error text. */
export function isDiagnosticCancellation(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR")) return true;
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 499
    && "errorType" in error && error.errorType === "client_closed_request" && "code" in error
    && (error.code === "client_cancelled" || error.code === "client_closed_request"));
}

export function terminalOutcome(evidence: { failed?: boolean; cancelled?: boolean; interrupted?: boolean; uncertain?: boolean }): Exclude<Outcome, "running"> {
  if (evidence.failed) return "failed";
  if (evidence.cancelled) return "cancelled";
  if (evidence.interrupted) return "interrupted";
  return evidence.uncertain ? "unknown" : "succeeded";
}
