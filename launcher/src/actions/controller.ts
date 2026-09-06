import { ProblemSchema, type Problem } from "../../../src/diagnostics/contracts";
import { isDiagnosticCancellation } from "../../../src/diagnostics/outcome";
import { DiagnosticRequestError, type DiagnosticRequestCode } from "../../../src/diagnostics/request-error";

export type ActionStatus = "pending" | "accepted" | "succeeded" | "cancelled" | "failed";
export type ActionNotice = { id: string; key: string; scope?: string; status: ActionStatus; detail?: string; errorCode?: DiagnosticRequestCode; problem?: Problem; traceId?: string };
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
  getSnapshot = () => this.notices;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(notice: ActionNotice) {
    this.notices = [notice, ...this.notices.filter(item => item.key !== notice.key || item.scope !== notice.scope)];
    for (const listener of this.listeners) listener();
  }
  dismiss = (id: string) => { this.notices = this.notices.filter(item => item.id !== id); for (const listener of this.listeners) listener(); };
  isActive(key: string) { return this.active.has(key); }
  correlate(key: string, problem: Problem) {
    const notice = this.notices.find(item => item.key === key);
    if (notice) this.publish({ ...notice, problem, traceId: problem.traceId });
  }
  complete(key: string, outcome: { status: Exclude<ActionStatus, "pending" | "accepted">; detail?: string; problem?: Problem; traceId?: string }) {
    const previous = this.notices.find(item => item.key === key);
    this.publish({ id: previous?.id ?? crypto.randomUUID(), key, ...outcome });
  }
  run<T>(key: string, work: () => Promise<T>, options: { scope?: string; classify?: (value: T) => Exclude<ActionStatus, "pending">; describe?: (value: T) => string | undefined; traceId?: string } = {}): Promise<ActionResult<T>> {
    // The key identifies one control's admitted action; same-key callers share its typed result.
    const admission = options.scope === undefined ? key : JSON.stringify([key, options.scope]);
    const duplicate = this.active.get(admission);
    if (duplicate) return duplicate as Promise<ActionResult<T>>;
    const id = crypto.randomUUID();
    let resolve!: (value: ActionResult<T>) => void;
    const result = new Promise<ActionResult<T>>(done => { resolve = done; });
    this.active.set(admission, result);
    this.publish({ id, key, scope: options.scope, status: "pending", traceId: options.traceId });
    void (async () => {
      try {
        const value = await work(), status = (options.classify ?? classifyAction)(value);
        const prior = this.notices.find(item => item.id === id);
        this.publish({ ...prior, id, key, scope: options.scope, status, detail: options.describe?.(value), traceId: prior?.traceId ?? options.traceId });
        resolve({ status, value });
      } catch (error) {
        const status = isDiagnosticCancellation(error) ? "cancelled" : "failed";
        const parsed = ProblemSchema.safeParse(error && typeof error === "object" && "problem" in error ? error.problem : undefined);
        const problem = parsed.success ? parsed.data : this.notices.find(item => item.id === id)?.problem;
        this.publish({ id, key, scope: options.scope, status, errorCode: error instanceof DiagnosticRequestError ? error.code : undefined, problem, traceId: problem?.traceId ?? options.traceId });
        resolve({ status, error, problem });
      } finally { this.active.delete(admission); }
    })();
    return result;
  }
}

export const launcherActions = new ActionController();
