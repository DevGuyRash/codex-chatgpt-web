import { QueryResultSchema, StatusSchema, type DiagnosticEvent, type DiagnosticQuery, type DiagnosticStatus, type DiagnosticsApi, type QueryResult } from "../../../src/diagnostics/contracts";
import { canonicalStages } from "../../../src/diagnostics/evidence";
import { diagnosticRequestCode, type DiagnosticRequestCode } from "../../../src/diagnostics/request-error";

export type DiagnosticTab = "overview" | "operations" | "advanced" | "capture";
export type DiagnosticFilters = { search: string; regex: boolean; severity: string; component: string; target: string; task: string; trace: string; from: string; to: string };
export const emptyFilters: DiagnosticFilters = { search: "", regex: false, severity: "", component: "", target: "", task: "", trace: "", from: "", to: "" };
export const emptyResult: QueryResult = { version: 1, events: [], incomplete: false, notices: [] };
export type FilterError = "regex" | "trace" | "date";
export function validateDiagnosticFilters(filters: DiagnosticFilters): FilterError | undefined {
  if (filters.regex && filters.search) { try { new RegExp(filters.search, "iu"); } catch { return "regex"; } }
  if (filters.trace && (!/^[a-f0-9]{32}$/.test(filters.trace) || /^0+$/.test(filters.trace))) return "trace";
  if ([filters.from, filters.to].some(value => value && !Number.isFinite(Date.parse(value))) || filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) return "date";
}
export function diagnosticFilterQuery(tab: DiagnosticTab, filters: DiagnosticFilters): DiagnosticQuery {
  if (validateDiagnosticFilters(filters)) throw new Error("Invalid diagnostic filters");
  return { view: tab === "overview" ? "groups" : tab === "operations" ? "operations" : "events", limit: 100,
    ...(filters.search ? filters.regex ? { regex: filters.search } : { text: filters.search } : {}),
    ...(filters.severity ? { severity: filters.severity as DiagnosticEvent["severity"] } : {}),
    ...(filters.component ? { component: filters.component } : {}), ...(filters.target ? { target: filters.target } : {}),
    ...(filters.task ? { taskId: filters.task } : {}), ...(filters.trace ? { traceId: filters.trace } : {}),
    ...(filters.from ? { from: Date.parse(filters.from) } : {}), ...(filters.to ? { to: Date.parse(filters.to) } : {}) };
}
type Selection = { id: string; traceId?: string; spanId?: string; fallback?: DiagnosticEvent; unavailable?: boolean };
export type DiagnosticsState = {
  tab: DiagnosticTab; filters: DiagnosticFilters; status?: DiagnosticStatus; statusError: boolean; now: number;
  result: QueryResult; trace: QueryResult; selection?: Selection; groups: Readonly<Record<string, QueryResult>>;
  live: boolean; newActivity: boolean; searching: boolean; foreground: boolean; loading: boolean; loadingMore: boolean;
  filterError?: FilterError; error?: DiagnosticRequestCode;
};
export interface DiagnosticsClock {
  now(): number;
  later(callback: () => void, milliseconds: number): () => void;
  every(callback: () => void, milliseconds: number): () => void;
}
const realtimeClock: DiagnosticsClock = {
  now: () => Date.now(),
  later: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); },
  every: (callback, milliseconds) => { const timer = setInterval(callback, milliseconds); return () => clearInterval(timer); },
};
type Request = { id: string; cancelled: boolean; started: boolean; done: Promise<QueryResult | undefined> };

/** One owner for UI query lanes and capture/health observations. No React or browser dependency. */
export class DiagnosticsController {
  private state: DiagnosticsState = { tab: "overview", filters: { ...emptyFilters }, now: Date.now(), statusError: false,
    result: emptyResult, trace: emptyResult, groups: {}, live: true, newActivity: false, searching: false, foreground: false, loading: false, loadingMore: false };
  private listeners = new Set<() => void>();
  private requests = new Map<string, Request>();
  private timer?: () => void;
  private searchTimer?: () => void;
  private observation?: Promise<void>;
  private clock?: () => void;
  private poll?: () => void;
  private unsubscribe?: () => void;
  private references = 0;
  private active = false;
  private inspecting = false;
  private expandedGroups = new Set<string>();
  private listVersion = 0;
  constructor(readonly api: DiagnosticsApi, private readonly clockSource: DiagnosticsClock = realtimeClock) { this.state.now = clockSource.now(); }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<DiagnosticsState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  acquire() {
    if (++this.references === 1) {
      void this.observe();
      this.unsubscribe = this.api.subscribe(() => { void this.observe(); });
      this.poll = this.clockSource.every(() => { void this.observe(); }, 5000);
      this.clock = this.clockSource.every(() => this.update({ now: this.clockSource.now() }), 1000);
    }
    return () => {
      if (--this.references === 0) {
        this.poll?.(); this.clock?.(); this.timer?.(); this.searchTimer?.(); this.unsubscribe?.();
        for (const lane of this.requests.keys()) this.cancelLane(lane);
      }
    };
  }
  async observe(): Promise<void> {
    if (this.observation) return this.observation;
    this.observation = (async () => {
      try {
        const status = StatusSchema.parse(await this.api.status());
        const previous = this.state.status;
        this.update({ status, statusError: !status.available });
        if (previous && (previous.lastSequence !== status.lastSequence || previous.eventCount !== status.eventCount || previous.newestTime !== status.newestTime)) {
          this.update({ newActivity: true });
          if (this.active && this.state.live && !this.inspecting && !this.expandedGroups.size && !this.state.selection && !this.state.loading && this.state.result.events.length <= 100) void this.reload("background");
        }
      } catch { this.update({ statusError: true }); }
    })().finally(() => { this.observation = undefined; });
    return this.observation;
  }
  activate(active: boolean) {
    this.active = active;
    if (active) { void this.observe(); void this.reload("foreground"); }
    else { this.timer?.(); this.cancelSearch(); for (const lane of this.requests.keys()) this.cancelLane(lane); }
  }
  setTab(tab: DiagnosticTab) {
    for (const lane of this.requests.keys()) this.cancelLane(lane);
    this.expandedGroups.clear();
    this.update({ tab, selection: undefined, trace: emptyResult, filters: { ...emptyFilters }, filterError: undefined, groups: {}, result: emptyResult });
    void this.reload("foreground");
  }
  setFilters(patch: Partial<DiagnosticFilters>) {
    const filters = { ...this.state.filters, ...patch };
    this.cancelSearch();
    this.update({ filters, filterError: validateDiagnosticFilters(filters), error: undefined });
    if (!this.state.filterError) this.timer = this.clockSource.later(() => { void this.reload("foreground"); }, 180);
  }
  setInspecting(value: boolean) { this.inspecting = value; }
  setGroupExpanded(key: string, value: boolean) { if (value) this.expandedGroups.add(key); else this.expandedGroups.delete(key); }
  setLive(live: boolean) { this.update({ live }); }
  query(): DiagnosticQuery { return diagnosticFilterQuery(this.state.tab, this.state.filters); }
  private cancelLane(lane: string) {
    const request = this.requests.get(lane);
    if (!request) return;
    request.cancelled = true;
    if (request.started) void this.api.cancelQuery(request.id).catch(() => {});
  }
  cancelSearch() {
    this.listVersion++; this.timer?.(); this.searchTimer?.(); this.cancelLane("list");
    this.update({ searching: false, foreground: false, loading: false, loadingMore: false });
  }
  private request(lane: string, query: DiagnosticQuery): Promise<QueryResult | undefined> {
    const previous = this.requests.get(lane);
    this.cancelLane(lane);
    const request: Request = { id: crypto.randomUUID(), cancelled: false, started: false, done: Promise.resolve(undefined) };
    request.done = (async () => {
      await previous?.done.catch(() => {});
      if (request.cancelled) return;
      request.started = true;
      try {
        const result = QueryResultSchema.parse(await this.api.query(query, request.id));
        if (!request.cancelled) return result;
      } catch (error) {
        if (!request.cancelled) { this.update({ error: diagnosticRequestCode(error, "query_failed") }); throw error; }
      }
    })().finally(() => { if (this.requests.get(lane) === request) this.requests.delete(lane); });
    this.requests.set(lane, request);
    return request.done;
  }
  async reload(reason: "foreground" | "background" = "foreground"): Promise<void> {
    this.timer?.(); this.searchTimer?.();
    if (this.state.tab === "capture" || this.state.filterError) { await this.observe(); return; }
    const version = ++this.listVersion;
    this.update({ loading: true, foreground: reason === "foreground", searching: false, error: undefined });
    if (reason === "foreground") this.searchTimer = this.clockSource.later(() => { if (version === this.listVersion) this.update({ searching: true }); }, 300);
    try {
      const result = await this.request("list", this.query());
      if (result && version === this.listVersion) {
        this.update({ result, newActivity: false });
        if (reason === "foreground") {
          if (this.state.selection) await this.loadTrace();
          for (const key of this.expandedGroups) if (result.groups?.some(group => group.key === key)) await this.loadGroup(key);
        }
      }
    } catch { /* The lane retains its structured failure; automatic work never rejects unobserved. */ }
    finally { if (version === this.listVersion) { this.searchTimer?.(); this.update({ loading: false, foreground: false, searching: false }); } }
  }
  async more(): Promise<void> {
    if (!this.state.result.nextCursor || this.state.loadingMore || this.state.loading) return;
    const version = this.listVersion;
    this.update({ loadingMore: true });
    try {
      const result = await this.request("list", { ...this.query(), cursor: this.state.result.nextCursor });
      if (result && version === this.listVersion) this.update({ result: { ...result, events: [...this.state.result.events, ...result.events], groups: [...(this.state.result.groups ?? []), ...(result.groups ?? [])] } });
    } finally { if (version === this.listVersion) this.update({ loadingMore: false }); }
  }
  async refresh() {
    await this.observe();
    await this.reload("foreground");
    return { ok: !this.state.filterError && !this.state.error && !this.state.statusError };
  }
  open(event: DiagnosticEvent) {
    this.update({ selection: { id: event.id, traceId: event.traceId, spanId: event.span ? event.spanId : undefined, fallback: event }, trace: emptyResult });
    void this.loadTrace().catch(() => {});
  }
  openTrace(traceId: string) { this.update({ tab: "operations", selection: { id: "", traceId }, trace: emptyResult }); void this.loadTrace().catch(() => {}); }
  closeSelection() { this.cancelLane("trace"); this.update({ selection: undefined, trace: emptyResult }); }
  async loadTrace(more = false): Promise<void> {
    const selection = this.state.selection;
    if (!selection || more && !this.state.trace.nextCursor) return;
    const result = await this.request("trace", { ...(selection.traceId ? { traceId: selection.traceId } : { eventId: selection.id }), limit: 200, ascending: true, ...(more ? { cursor: this.state.trace.nextCursor } : {}) });
    if (result && this.state.selection?.traceId === selection.traceId) this.update({ trace: more ? { ...result, events: [...this.state.trace.events, ...result.events] } : result,
      selection: !more && !result.nextCursor && selection.id && !result.events.some(event => event.id === selection.id || selection.spanId && event.spanId === selection.spanId) ? { ...selection, fallback: undefined, unavailable: true } : this.state.selection });
  }
  selected(): DiagnosticEvent | undefined {
    const selection = this.state.selection;
    if (!selection || selection.unavailable) return;
    const events = [...this.state.result.events, ...this.state.trace.events];
    if (selection.spanId) return canonicalStages(events).find(event => event.spanId === selection.spanId && event.traceId === selection.traceId) ?? selection.fallback;
    return events.find(event => event.id === selection.id) ?? selection.fallback
      ?? this.state.trace.events.find(event => event.problem)
      ?? canonicalStages(this.state.trace.events).find(event => !event.parentSpanId);
  }
  async loadGroup(key: string, more = false): Promise<void> {
    const previous = this.state.groups[key];
    const result = await this.request(`group:${key}`, { view: "occurrences", groupKey: key, limit: 50, ...(more ? { cursor: previous?.nextCursor } : {}), snapshotSequence: this.state.result.snapshotSequence });
    if (result) this.update({ groups: { ...this.state.groups, [key]: more && previous ? { ...result, events: [...previous.events, ...result.events] } : result } });
  }
  cleared() { this.cancelSearch(); this.cancelLane("trace"); this.update({ result: emptyResult, trace: emptyResult, groups: {}, selection: undefined }); void this.observe(); void this.reload(); }
}

const controllers = new WeakMap<DiagnosticsApi, DiagnosticsController>();
export function diagnosticsController(api: DiagnosticsApi) {
  let controller = controllers.get(api);
  if (!controller) { controller = new DiagnosticsController(api); controllers.set(api, controller); }
  return controller;
}
