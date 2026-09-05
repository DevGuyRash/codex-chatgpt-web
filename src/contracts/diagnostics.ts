/** Data only: recovery actions navigate to existing owners; they never authorize a mutation. */
export type RecoveryAction = "run-doctor" | "review-configuration" | "review-setup" | "export-logs";
export interface DiagnosticFinding { path?: string; message: string }
export interface DiagnosticProblem {
  code: string;
  message: string;
  findings: DiagnosticFinding[];
  actions: RecoveryAction[];
}
export interface DoctorCheck {
  id: string;
  status: "ok" | "warning" | "error";
  message: string;
  detail?: string;
  code?: string;
  findings?: DiagnosticFinding[];
  problem?: DiagnosticProblem;
}
export interface DoctorReport {
  ok: boolean;
  mode?: "browser-only" | "full";
  checks: DoctorCheck[];
}
