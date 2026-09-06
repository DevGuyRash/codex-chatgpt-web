import type { Outcome } from "./contracts";

export function diagnosticCancellation(message = "Operation cancelled") {
  return Object.assign(new Error(message), { name: "AbortError", code: "ABORT_ERR" });
}

/** Cancellation is evidence from an owner, never inferred from arbitrary error text. */
export function isDiagnosticCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR");
}

export function terminalOutcome(evidence: { failed?: boolean; cancelled?: boolean; interrupted?: boolean; uncertain?: boolean }): Exclude<Outcome, "running"> {
  if (evidence.failed) return "failed";
  if (evidence.cancelled) return "cancelled";
  if (evidence.interrupted) return "interrupted";
  return evidence.uncertain ? "unknown" : "succeeded";
}
