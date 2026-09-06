import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../src/diagnostics/store";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";

function problem(index: number, code = "test_failure"): DiagnosticEvent {
  return { version: 1, id: crypto.randomUUID(), time: 1000 + index, name: code, kind: "problem", severity: "error", body: "Fixture failed", component: "fixture", environment: "test", target: "base", traceId: index.toString(16).padStart(32, "1"), spanId: "a".repeat(16), attributes: { "service.version": "1" }, problem: { version: 1, code, stage: "fixture.stage", message: "Fixture failed", findings: [], causes: [], actions: [], recovery: "unknown" } };
}

test("problem groups count occurrences rather than duplicate records and page chronologically", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-groups-"));
  const store = new DiagnosticStore(root, { now: () => 2000 });
  try {
    const first = problem(1), second = problem(2), other = problem(3, "other_failure");
    store.append([first, second, { ...second, id: crypto.randomUUID() }, other]);
    const page = store.query({ view: "groups", limit: 1 });
    expect(page.events.map(event => event.id)).toEqual([other.id]);
    expect(page.groups?.[0].occurrences).toBe(1);
    store.append([problem(9, "new_failure")]);
    const next = store.query({ view: "groups", limit: 1, cursor: page.nextCursor });
    expect(next.groups?.[0].occurrences).toBe(2);
    expect(next.groups?.[0].firstTime).toBe(first.time);
    const occurrences = store.query({ view: "occurrences", groupKey: next.groups![0].key, limit: 1 });
    expect(occurrences.events[0].traceId).toBe(second.traceId);
    expect(store.query({ view: "occurrences", groupKey: next.groups![0].key, limit: 1, cursor: occurrences.nextCursor }).events[0].id).toBe(first.id);
    expect(store.status().eventCount).toBe(5);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("ambiguous generic errors are not grouped across unrelated operations", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-groups-"));
  const store = new DiagnosticStore(root, { now: () => 2000 });
  try {
    store.append([problem(1, "operation_failed"), problem(2, "operation_failed")]);
    expect(store.query({ view: "groups" }).groups).toHaveLength(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("propagated errors in one operation remain one occurrence represented by its first recorded problem", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-groups-"));
  const store = new DiagnosticStore(root, { now: () => 2000 });
  try {
    const first = problem(1, "setup_preview_stale");
    const propagated = { ...first, id: crypto.randomUUID(), time: first.time + 1, component: "launcher", problem: { ...first.problem!, stage: "runtime-upgrade" } };
    store.append([first, propagated]);
    const groups = store.query({ view: "groups" });
    expect(groups.groups).toHaveLength(1);
    expect(groups.events[0].id).toBe(first.id);
    expect(groups.groups?.[0].occurrences).toBe(1);
    expect(store.query({ traceId: first.traceId }).events).toHaveLength(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
