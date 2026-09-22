import { ProblemSchema, type Problem } from "../../../src/diagnostics/contracts";
import { isDiagnosticCancellation } from "../../../src/diagnostics/outcome";
import { DiagnosticRequestError, type DiagnosticRequestCode } from "../../../src/diagnostics/request-error";

export type ActionStatus = "pending" | "accepted" | "succeeded" | "cancelled" | "failed";
export type ActionEvidence = { kind: "browser-test"; responseCharacters: number } | { kind: "checks"; total: number; issues: number };
export type ActionNotice = { id: string; key: string; scope?: string; status: ActionStatus; detail?: string; evidence?: ActionEvidence; errorCode?: DiagnosticRequestCode; problem?: Problem; traceId?: string; startedAt?: number; updatedAt?: number; dismissedAt?: number };
export type ActionResult<T> = { status: Exclude<ActionStatus, "pending">; value?: T; problem?: Problem; error?: unknown };
export function classifyAction(value: unknown): Exclude<ActionStatus, "pending"> {
  if (value && typeof value === "object") {
    if ("cancelled" in value && value.cancelled === true) return "cancelled";
    if ("ok" in value && value.ok === false) return "failed";
    if ("accepted" in value && value.accepted === true) return "accepted";
  }
  return "succeeded";
}

/** Owns admission and notices only. Runtime/process owners still execute and terminalize work. */
export class ActionController {
  private notices: ActionNotice[] = [];
  private listeners = new Set<() => void>();
  private active = new Map<string, Promise<ActionResult<unknown>>>();
  private retained = new Map<string, number>();
  getSnapshot = () => this.notices;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(notice: ActionNotice) {
    notice = { ...notice, startedAt: notice.startedAt ?? Date.now(), updatedAt: Date.now() };
    // Transient UI history is bounded; pending work and currently inspected notices stay reachable.
    this.notices = [notice, ...this.notices.filter(item => item.id !== notice.id)]
      .filter((item, index) => index < 50 || item.status === "pending" || item.status === "accepted" || this.retained.has(item.id));
    for (const listener of this.listeners) listener();
  }
  dismiss = (id: string) => { this.notices = this.notices.map(item => item.id === id ? { ...item, dismissedAt: Date.now() } : item); for (const listener of this.listeners) listener(); };
  clearHistory = () => { this.notices = this.notices.filter(item => item.status === "pending" || item.status === "accepted" || this.retained.has(item.id)); for (const listener of this.listeners) listener(); };
  isActive(key: string) { return this.active.has(key); }
  retain(id: string) {
    this.retained.set(id, (this.retained.get(id) ?? 0) + 1);
    return () => { const count = this.retained.get(id) ?? 0; if (count <= 1) this.retained.delete(id); else this.retained.set(id, count - 1); };
  }
  correlate(key: string, problem: Problem) {
    const notice = this.notices.find(item => item.key === key);
    if (notice) this.publish({ ...notice, problem, traceId: problem.traceId });
  }
  describe(key: string, detail: string) {
    const notice = this.notices.find(item => item.key === key);
    if (notice) this.publish({ ...notice, detail });
  }
  complete(key: string, outcome: { status: Exclude<ActionStatus, "pending" | "accepted">; detail?: string; problem?: Problem; traceId?: string }) {
    const previous = this.notices.find(item => item.key === key && (outcome.traceId ? item.traceId === outcome.traceId : item.status === "pending" || item.status === "accepted"));
    this.publish({ id: previous?.id ?? crypto.randomUUID(), startedAt: previous?.startedAt, scope: previous?.scope, key, ...outcome });
  }
  run<T>(key: string, work: () => Promise<T>, options: { scope?: string; classify?: (value: T) => Exclude<ActionStatus, "pending">; describe?: (value: T) => string | undefined; evidence?: (value: T) => ActionEvidence | undefined; traceId?: string } = {}): Promise<ActionResult<T>> {
    // The key identifies one control's admitted action; same-key callers share its typed result.
    const admission = options.scope === undefined ? key : JSON.stringify([key, options.scope]);
    const duplicate = this.active.get(admission);
    if (duplicate) return duplicate as Promise<ActionResult<T>>;
    const id = crypto.randomUUID();
    let resolve!: (value: ActionResult<T>) => void;
    const result = new Promise<ActionResult<T>>(done => { resolve = done; });
    this.active.set(admission, result);
    this.publish({ id, key, scope: options.scope, status: "pending", traceId: options.traceId, startedAt: Date.now() });
    void (async () => {
      try {
        const value = await work(), status = (options.classify ?? classifyAction)(value);
        const prior = this.notices.find(item => item.id === id);
        const parsed = ProblemSchema.safeParse(value && typeof value === "object" && "problem" in value ? value.problem : undefined);
        this.publish({ ...prior, id, key, scope: options.scope, status, problem: parsed.success ? parsed.data : prior?.problem, detail: options.describe?.(value) ?? prior?.detail, evidence: options.evidence?.(value), traceId: parsed.success ? parsed.data.traceId : prior?.traceId ?? options.traceId });
        resolve({ status, value });
      } catch (error) {
        const status = isDiagnosticCancellation(error) ? "cancelled" : "failed";
        const parsed = ProblemSchema.safeParse(error && typeof error === "object" && "problem" in error ? error.problem : undefined);
        const problem = parsed.success ? parsed.data : this.notices.find(item => item.id === id)?.problem;
        this.publish({ id, key, scope: options.scope, status, startedAt: this.notices.find(item => item.id === id)?.startedAt, errorCode: error instanceof DiagnosticRequestError ? error.code : undefined, problem, traceId: problem?.traceId ?? options.traceId });
        resolve({ status, error, problem });
      } finally { this.active.delete(admission); }
    })();
    return result;
  }
}

export const launcherActions = new ActionController();
