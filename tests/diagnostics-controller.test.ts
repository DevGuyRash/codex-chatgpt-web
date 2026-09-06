import { expect, test } from "bun:test";
import { DiagnosticsController, validateDiagnosticFilters, emptyFilters, emptyResult, type DiagnosticsClock } from "../launcher/src/diagnostics/controller";
import { canonicalStages, stageHierarchy, hasOutcomeConflict } from "../src/diagnostics/evidence";
import { unavailableStatus, type DiagnosticsApi, type QueryResult, type DiagnosticEvent } from "../src/diagnostics/contracts";

class Clock implements DiagnosticsClock {
  time = 1000;
  tasks = new Set<{ at: number; callback: () => void; repeat?: number }>();
  now = () => this.time;
  later(callback: () => void, milliseconds: number) { const task = { at: this.time + milliseconds, callback }; this.tasks.add(task); return () => { this.tasks.delete(task); }; }
  every(callback: () => void, milliseconds: number) { const task = { at: this.time + milliseconds, callback, repeat: milliseconds }; this.tasks.add(task); return () => { this.tasks.delete(task); }; }
  advance(milliseconds: number) {
    const end = this.time + milliseconds;
    for (;;) {
      const next = [...this.tasks].filter(task => task.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.time = next.at; if (next.repeat) next.at += next.repeat; else this.tasks.delete(next); next.callback();
    }
    this.time = end;
  }
}

test("foreground progress waits 300ms and background refresh never flashes cancellation", async () => {
  const clock = new Clock(); let resolve!: (result: QueryResult) => void;
  const api = { query: async () => new Promise<QueryResult>(done => { resolve = done; }), cancelQuery: async () => {} } as unknown as DiagnosticsApi;
  const controller = new DiagnosticsController(api, clock);
  const foreground = controller.reload(); await Promise.resolve();
  clock.advance(299); expect(controller.getSnapshot().searching).toBe(false);
  clock.advance(1); expect(controller.getSnapshot().searching).toBe(true);
  resolve(emptyResult); await foreground;
  const background = controller.reload("background"); await Promise.resolve(); clock.advance(1000);
  expect(controller.getSnapshot().searching).toBe(false);
  resolve(emptyResult); await background;
});

test("pause keeps capture expiry and health fresh; failed status preserves the last observation", async () => {
  const clock = new Clock(); let fail = false;
  const status = { ...unavailableStatus(""), available: true, notices: [], captures: { debugUntil: 1500, privateUntil: 1500, privateScope: "next-browser-turn" } };
  const api = { status: async () => { if (fail) throw new Error("offline"); return status; }, subscribe: () => () => {} } as unknown as DiagnosticsApi;
  const controller = new DiagnosticsController(api, clock), release = controller.acquire();
  try {
    await controller.observe(); controller.setLive(false); clock.advance(1000);
    expect(controller.getSnapshot().now).toBeGreaterThan(controller.getSnapshot().status!.captures.privateUntil);
    fail = true; await controller.observe();
    expect(controller.getSnapshot().statusError).toBe(true);
    expect(controller.getSnapshot().status?.captures.privateUntil).toBe(1500);
  } finally { release(); }
  expect(clock.tasks.size).toBe(0);
});

test("invalid filters cannot silently broaden the query", () => {
  expect(validateDiagnosticFilters({ ...emptyFilters, regex: true, search: "[" })).toBe("regex");
  expect(validateDiagnosticFilters({ ...emptyFilters, trace: "0".repeat(32) })).toBe("trace");
  expect(validateDiagnosticFilters({ ...emptyFilters, from: "2026-09-05T12:00", to: "2026-09-04T12:00" })).toBe("date");
});

test("replacement search cancels only its lane and discards the old result", async () => {
  const requests: Array<{ id: string; resolve: (value: QueryResult) => void }> = [];
  const cancelled: string[] = [];
  const api = { query: async (_query: unknown, id: string) => new Promise<QueryResult>(resolve => requests.push({ id, resolve })), cancelQuery: async (id: string) => { cancelled.push(id); } } as unknown as DiagnosticsApi;
  const controller = new DiagnosticsController(api);
  const first = controller.reload(); await Promise.resolve();
  controller.openTrace("a".repeat(32)); await Promise.resolve();
  const replacement = controller.reload();
  expect(cancelled).toEqual([requests[0].id]);
  requests[0].resolve({ ...emptyResult, notices: ["stale"] });
  await first; await Promise.resolve();
  requests[1].resolve(emptyResult);
  requests[2].resolve({ ...emptyResult, notices: ["latest"] });
  // A deliberate foreground refresh also refreshes the selected trace after the list settles.
  for (let i = 0; i < 10 && requests.length < 4; i++) await Promise.resolve();
  requests[3]?.resolve(emptyResult);
  await replacement;
  expect(controller.getSnapshot().result.notices).toEqual(["latest"]);
  expect(controller.getSnapshot().searching).toBe(false);
});

function stage(id: string, parent?: string, terminal = true): DiagnosticEvent {
  return { version: 1, id: crypto.randomUUID(), time: terminal ? 2 : 3, kind: "span", name: id, body: id, severity: "info", component: "fixture", environment: "test", target: "base", traceId: "a".repeat(32), spanId: id.repeat(16), parentSpanId: parent?.repeat(16), attributes: {}, span: terminal ? { startTime: 1, endTime: 2, outcome: "cancelled" } : { startTime: 1, outcome: "running" } };
}

test("opening a failure by trace presents its structured problem before its root stage", async () => {
  const root = stage("b");
  const problem: DiagnosticEvent = { ...root, id: crypto.randomUUID(), kind: "problem", span: undefined, problem: { version: 1, code: "setup_preview_stale", message: "Review a fresh preview", actions: ["review-setup"], findings: [], causes: [], recovery: "not-started" } };
  const controller = new DiagnosticsController({ query: async () => ({ ...emptyResult, events: [root, problem] }), cancelQuery: async () => {} } as unknown as DiagnosticsApi);
  controller.openTrace(root.traceId!);
  await controller.loadTrace();
  expect(controller.selected()?.problem?.code).toBe("setup_preview_stale");
  controller.open(root);
  expect(controller.selected()?.spanId).toBe(root.spanId);
});
test("timeline preserves terminal evidence and real nested parentage", () => {
  const root = stage("b"), child = stage("c", "b"), grandchild = stage("d", "c");
  expect(canonicalStages([root, stage("b", undefined, false)])[0].span?.outcome).toBe("cancelled");
  expect(stageHierarchy([root, child, grandchild]).map(row => row.depth)).toEqual([0, 1, 2]);
  const problem: DiagnosticEvent = { ...root, id: crypto.randomUUID(), kind: "problem", span: undefined, problem: { version: 1, code: "operation_failed", message: "Historical error", actions: [], findings: [], causes: [], recovery: "unknown" } };
  expect(hasOutcomeConflict(problem, [root, problem])).toBe(true);
});
