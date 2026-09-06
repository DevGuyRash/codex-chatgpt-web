import { ProblemSchema, type Problem } from "./contracts";
import { safeProblem, safeText } from "./privacy";

const recovery: Record<string, Problem["actions"]> = {
  codex_configuration_conflict: ["review-configuration", "open-diagnostics", "run-doctor"],
  codex_route_missing: ["review-setup", "open-diagnostics"],
  setup_preview_stale: ["review-setup", "open-diagnostics"],
};
export class DiagnosticError extends Error {
  readonly problem: Problem;
  readonly code: string;
  readonly findings: Problem["findings"];
  constructor(problem: Pick<Problem, "code" | "message"> & Partial<Problem>) {
    const parsed = safeProblem(ProblemSchema.parse({ ...problem, actions: problem.actions ?? recovery[problem.code] ?? ["open-diagnostics", "run-doctor", "export-logs"] }));
    super(parsed.message); this.name = "DiagnosticError"; this.problem = parsed; this.code = parsed.code; this.findings = parsed.findings;
  }
}
export function problemFor(error: unknown, fallback = "The operation failed; open Diagnostics to inspect its stages", context: Partial<Problem> = {}): Problem {
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const existing = ProblemSchema.safeParse(candidate.problem);
  if (existing.success) return safeProblem(ProblemSchema.parse({ ...existing.data, ...context }));
  const code = typeof candidate.code === "string" && Object.hasOwn(recovery, candidate.code) ? candidate.code : "operation_failed";
  const findings = Array.isArray(candidate.findings) ? candidate.findings : Array.isArray(candidate.conflicts) ? candidate.conflicts : [];
  // Only application-owned structured failures may carry detailed text. Unknown child output is not a safe error contract.
  const message = code === "codex_configuration_conflict" ? "Codex configuration differs from this installation; review the proposed changes"
    : code === "setup_preview_stale" ? "Setup inputs changed since the review; review a fresh preview before continuing"
    : safeText(fallback);
  return safeProblem(ProblemSchema.parse({ code, message, actions: recovery[code] ?? ["open-diagnostics", "run-doctor", "export-logs"],
    findings: findings.slice(0, 512).flatMap(item => item && typeof item === "object" && typeof item.message === "string" ? [{ path: typeof item.path === "string" ? safeText(item.path) : undefined, message: safeText(item.message) }] : []),
    ...context,
  }));
}
export function runtimeFailure(stderr: string, fallback: string, context: Partial<Problem> = {}): DiagnosticError {
  if (context.exitCode === 130 && stderr.split(/\r?\n/).includes('CGW_CANCELLED_V1 {"version":1}')) {
    const cancelled = new DiagnosticError({ code: "operation_cancelled", message: "Operation cancelled", recovery: "not-needed", actions: [] });
    cancelled.name = "AbortError"; return cancelled;
  }
  const line = stderr.split(/\r?\n/).find(line => line.startsWith("CGW_ERROR_V2 ") || line.startsWith("CGW_ERROR_V1 "));
  if (line) {
    try {
      if (line.length >= 256 * 1024) throw new Error("Problem envelope exceeded its bound");
      const parsed: unknown = JSON.parse(line.slice(13));
      if (line.startsWith("CGW_ERROR_V2 ")) {
        const result = ProblemSchema.safeParse(parsed);
        if (result.success) return new DiagnosticError({ ...result.data, ...context });
      } else if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 1 && "code" in parsed && parsed.code === "codex_configuration_conflict") return new DiagnosticError(problemFor(parsed, fallback, context));
    } catch { /* Unknown child data has no recovery authority. */ }
    return new DiagnosticError({ code: "unsupported_problem", message: "The runtime returned an unsupported error record; inspect component versions in Diagnostics", ...context });
  }
  return new DiagnosticError({ code: "operation_failed", message: safeText(fallback), ...context });
}

export function withRecovery<T extends { checks: Array<{ status: string; message: string; code?: string }> }>(report: T) {
  return { ...report, checks: report.checks.map(check => check.status === "ok" ? check : { ...check, problem: problemFor(check, check.message, check.code && Object.hasOwn(recovery, check.code) ? {} : { actions: ["open-diagnostics", "export-logs"] }) }) };
}
