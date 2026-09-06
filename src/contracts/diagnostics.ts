/** Data only: recovery actions navigate to existing owners; they never authorize a mutation. */
import type { Problem } from "../diagnostics/contracts";
export type RecoveryAction = Problem["actions"][number];
export type DiagnosticFinding = Problem["findings"][number];
/** Older Doctor producers may omit the new fields; runtime validation supplies defaults at ingress. */
export type DiagnosticProblem = Pick<Problem, "code" | "message" | "findings" | "actions"> & Partial<Omit<Problem, "code" | "message" | "findings" | "actions">>;
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
