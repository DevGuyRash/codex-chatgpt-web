import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DiagnosticStore } from "../src/diagnostics/store";
import { DiagnosticEventSchema, type DiagnosticEvent } from "../src/diagnostics/contracts";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "diagnostics-test-")); roots.push(path); return path; }
function event(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent { return DiagnosticEventSchema.parse({ version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "log", name: "setup.preflight", body: "Configuration review complete", severity: "info", component: "runtime", environment: "test", target: "base", attributes: {}, ...overrides }); }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("legacy import batches records without one transaction per line", async () => {
  const path = root(); const file = join(path, "legacy.jsonl");
  writeFileSync(file, Array.from({ length: 1024 }, (_, index) => JSON.stringify({ at: new Date().toISOString(), event: `legacy.event.${index}`, level: "info" })).join("\n"));
  const store = new DiagnosticStore(path); const append = store.append.bind(store); const batches: number[] = [];
  store.append = records => { batches.push(records.length); return append(records); };
  try {
    expect(await store.importLegacy([file], "legacy", "test")).toBe(1024);
    expect(batches.length).toBeLessThanOrEqual(8);
    expect(batches.every(count => count > 0 && count <= 128)).toBe(true);
    expect(store.status().eventCount).toBe(1024);
    expect(await store.importLegacy([file], "legacy", "test")).toBe(0);
  } finally { store.close(); }
});

test("interrupted legacy import resumes without duplicates or a false completion marker", async () => {
  const path = root(); const file = join(path, "legacy.jsonl");
  writeFileSync(file, Array.from({ length: 512 }, (_, index) => JSON.stringify({ at: new Date().toISOString(), event: `legacy.event.${index}`, level: "info" })).join("\n"));
  const store = new DiagnosticStore(path); const append = store.append.bind(store); const abort = new AbortController();
  store.append = records => { const count = append(records); abort.abort(); return count; };
  try {
    await expect(Promise.resolve().then(() => store.importLegacy([file], "legacy", "test", abort.signal))).rejects.toThrow();
    expect(store.status().eventCount).toBeLessThan(512);
    store.append = append;
    await store.importLegacy([file], "legacy", "test");
    expect(store.status().eventCount).toBe(512);
    expect(await store.importLegacy([file], "legacy", "test")).toBe(0);
  } finally { store.close(); }
});

test("legacy storage failure is not swallowed as a malformed input line", async () => {
  const path = root(); const file = join(path, "legacy.jsonl");
  writeFileSync(file, Array.from({ length: 256 }, (_, index) => JSON.stringify({ at: new Date().toISOString(), event: `legacy.event.${index}`, level: "info" })).join("\n"));
  const store = new DiagnosticStore(path); const append = store.append.bind(store); let batches = 0;
  store.append = records => { if (++batches === 2) throw new Error("Synthetic storage failure"); return append(records); };
  try {
    await expect(Promise.resolve().then(() => store.importLegacy([file], "legacy", "test"))).rejects.toThrow("Synthetic storage failure");
    store.append = append; await store.importLegacy([file], "legacy", "test");
    expect(store.status().eventCount).toBe(256);
  } finally { store.close(); }
});

test("trace, problem, and duration projections are atomic, deduplicated, and cleared with their evidence", () => {
  const path = root(); const store = new DiagnosticStore(path);
  const traceId = "a".repeat(32); const spanId = "b".repeat(16);
  const records = [event({ traceId, spanId, kind: "span", span: { startTime: 10, endTime: 25, outcome: "failed" } }), event({ traceId, spanId, kind: "problem", problem: { version: 1, code: "test_failure", message: "Failure", findings: [], causes: [], actions: [], recovery: "unknown" } })];
  store.append(records); store.append(records);
  const db = new Database(join(path, "diagnostics.sqlite"), { readonly: true });
  try {
    expect(db.query("SELECT event_count FROM traces WHERE trace_id=?").get(traceId)).toEqual({ event_count: 2 });
    expect(db.query("SELECT code FROM problems").all()).toEqual([{ code: "test_failure" }]);
    expect(db.query("SELECT name,value,unit FROM metrics").all()).toEqual([{ name: "operation.duration", value: 15, unit: "ms" }]);
    store.clear("normal", true);
    for (const table of ["traces", "problems", "metrics"]) expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  } finally { db.close(); store.close(); }
});
test("schema-one records survive projection migration and reopen without duplicate backfill", () => {
  const path = root(); let store = new DiagnosticStore(path);
  const record = event({ traceId: "a".repeat(32), spanId: "b".repeat(16), kind: "span", span: { startTime: 10, endTime: 20, outcome: "succeeded" } });
  store.append([record]); store.close();
  // Reconstruct the preceding schema: projections contain no independent user data.
  const previous = new Database(join(path, "diagnostics.sqlite"));
  previous.exec("DROP TRIGGER evidence_ai; DROP TRIGGER evidence_ad; DROP TABLE traces; DROP TABLE problems; DROP TABLE metrics; PRAGMA user_version=1"); previous.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    store = new DiagnosticStore(path);
    expect(store.query().events.map(item => item.id)).toEqual([record.id]);
    expect(store.status().schemaVersion).toBe(2);
    const db = new Database(join(path, "diagnostics.sqlite"), { readonly: true });
    expect(db.query("SELECT event_count FROM traces").all()).toEqual([{ event_count: 1 }]);
    expect(db.query("SELECT value FROM metrics").all()).toEqual([{ value: 10 }]);
    db.close(); store.close();
  }
});

test("read-only diagnostics do not create a database or start a runtime", () => {
  const path = join(root(), "not-created");
  const store = new DiagnosticStore(path, { readonly: true });
  expect(store.status().available).toBe(false);
  expect(store.query().events).toEqual([]);
  expect(existsSync(path)).toBe(false); store.close();
});
test("queries disclose truncated evidence rather than implying complete records", () => {
  const store = new DiagnosticStore(root());
  store.append([event({ attributes: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, "x".repeat(4096)])) })]);
  const result = store.query();
  expect(result.events[0]?.attributes["diagnostics.truncated"]).toBe(true);
  expect(result.incomplete).toBe(true);
  expect(result.notices.join(" ")).toContain("truncated");
  store.close();
});
test("indexed search, deterministic pagination, deduplication, and injection-safe filters", () => {
  const store = new DiagnosticStore(root());
  const events = Array.from({ length: 5 }, (_, index) => event({ body: `Configuration step ${index}` }));
  expect(store.append(events)).toBe(5); expect(store.append(events)).toBe(0);
  const first = store.query({ limit: 2, text: "Configuration" });
  const second = store.query({ limit: 2, text: "Configuration", cursor: first.nextCursor });
  expect(first.events).toHaveLength(2); expect(second.events).toHaveLength(2);
  expect(first.events.some(item => second.events.some(other => item.id === other.id))).toBe(false);
  expect(() => store.query({ text: "different", cursor: first.nextCursor })).toThrow("cursor");
  expect(store.query({ component: "' OR 1=1 --" }).events).toHaveLength(0);
  expect(store.query({ text: '" OR *' }).events).toHaveLength(0); store.close();
});
test("terminal spans cannot be resurrected by delayed start events", () => {
  const store = new DiagnosticStore(root());
  const span = { traceId: "1".repeat(32), spanId: "2".repeat(16), kind: "span" as const };
  store.append([event({ ...span, span: { startTime: 10, endTime: 20, outcome: "failed" } })]);
  store.append([event({ ...span, span: { startTime: 10, outcome: "running" } })]);
  expect(store.query({ view: "operations" }).events[0]?.span?.outcome).toBe("failed"); store.close();
});
test("overview includes interrupted operations without inventing a problem or showing successful operations", () => {
  const store = new DiagnosticStore(root()); const traceId = "a".repeat(32);
  const interrupted = event({ traceId, spanId: "b".repeat(16), kind: "span", span: { startTime: 10, endTime: 20, outcome: "interrupted" } });
  store.append([interrupted, event({ traceId, spanId: "c".repeat(16), kind: "span", span: { startTime: 10, endTime: 20, outcome: "succeeded" } })]);
  expect(store.query({ view: "overview" }).events.map(item => item.id)).toEqual([interrupted.id]);
  store.close();
});
test("unfinished operations disclose that recorded running state is not current liveness evidence", () => {
  const store = new DiagnosticStore(root());
  store.append([event({ kind: "span", traceId: "a".repeat(32), spanId: "b".repeat(16), span: { startTime: Date.now(), outcome: "running" } })]);
  const result = store.query({ view: "operations" });
  expect(result.incomplete).toBe(true);
  expect(result.notices.join(" ")).toContain("last observed");
  store.close();
});
test("retention expires records and capture sessions across reopen", () => {
  let now = Date.now(); const path = root();
  let store = new DiagnosticStore(path, { now: () => now });
  store.append([event({ time: now - 15 * 86400_000 }), event({ time: now })]);
  store.capture({ action: "debug-start" });
  store.capture({ action: "private-start", acknowledged: true, scope: "next-browser-turn" });
  expect(store.claimPrivateCapture("1".repeat(32))).toBe(true);
  expect(store.claimPrivateCapture("2".repeat(32))).toBe(false);
  store.prune(); expect(store.status().eventCount).toBe(1);
  expect(store.status().notices.join(" ")).toContain("1 records removed by retention");
  store.close();
  now += 31 * 60_000; store = new DiagnosticStore(path, { now: () => now });
  expect(store.captures()).toEqual({ debugUntil: 0, privateUntil: 0, privateScope: "" }); store.close();
});
test("clearing requires confirmation and preserves capture controls for normal clear", () => {
  const store = new DiagnosticStore(root()); store.append([event()]); store.capture({ action: "debug-start" });
  expect(() => store.clear("normal", false)).toThrow("confirmation");
  expect(store.clear("normal", true).eventCount).toBe(0);
  expect(store.captures().debugUntil).toBeGreaterThan(Date.now()); store.close();
});

test("follow cursors drain bursts and find late events regardless of producer clocks", () => {
  const store = new DiagnosticStore(root());
  store.append(Array.from({ length: 128 }, () => event()));
  const first = store.query({ ascending: true, follow: true, limit: 100 });
  const next = store.query({ ascending: true, follow: true, limit: 100, cursor: first.nextCursor });
  expect(first.events).toHaveLength(100); expect(next.events).toHaveLength(28);
  const late = event({ time: Date.now() - 60_000 }); store.append([late]);
  const fresh = store.query({ ascending: true, follow: true, limit: 100, cursor: next.followCursor });
  expect(fresh.events.map(item => item.id)).toEqual([late.id]);
  expect(store.query({ ascending: true, follow: true, cursor: fresh.followCursor }).events).toHaveLength(0);
  store.close();
});

test("private images require a claimed scope, survive only within retention, and stop revokes admission", () => {
  let now = Date.now(); const path = root();
  const store = new DiagnosticStore(path, { now: () => now });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const trace = "1".repeat(32);
  expect(store.writePrivateCapture(trace, png)).toEqual({ status: "omitted", reason: "inactive" });
  store.capture({ action: "private-start", scope: "next-browser-turn", acknowledged: true });
  expect(store.claimPrivateCapture(trace)).toBe(true);
  expect(store.claimPrivateCapture("2".repeat(32))).toBe(false);
  const stored = store.writePrivateCapture(trace, png);
  expect(stored.status).toBe("stored");
  expect(store.status().privateBytes).toBe(png.byteLength);
  store.capture({ action: "private-stop" });
  expect(store.writePrivateCapture(trace, png)).toEqual({ status: "omitted", reason: "inactive" });
  expect(store.query().events).toHaveLength(0);
  now += 24 * 60 * 60_000 + 1;
  store.prune(); expect(store.status().privateBytes).toBe(0);
  expect(store.status().notices.join(" ")).toContain("private captures expired");
  store.close();
});

test("missing private evidence is disclosed and confirmed deletion removes owned orphan images", () => {
  const path = root(); const store = new DiagnosticStore(path); const trace = "a".repeat(32);
  store.capture({ action: "private-start", scope: trace, acknowledged: true });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const stored = store.writePrivateCapture(trace, png);
  if (stored.status !== "stored") throw new Error("Fixture capture was not admitted");
  rmSync(join(path, "private", `${stored.id}.png`));
  store.prune(); expect(store.status().notices.join(" ")).toContain("private captures are missing");
  const orphan = join(path, "private", `${crypto.randomUUID()}.png`); writeFileSync(orphan, png);
  const unrelated = join(path, "private", "unrelated.txt"); writeFileSync(unrelated, "not a capture");
  store.clear("private", true);
  expect(existsSync(orphan)).toBe(false); expect(existsSync(unrelated)).toBe(true);
  store.close();
});

test("SQLite capacity exhaustion rolls back a batch and preserves retained evidence", () => {
  const store = new DiagnosticStore(root()); const original = event(); store.append([original]);
  // Fault injection on this disposable connection produces real SQLITE_FULL without filling the host disk.
  const db = (store as unknown as { database: Database }).database;
  const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  db.exec(`PRAGMA max_page_count=${pages + 1}`);
  const records = Array.from({ length: 128 }, () => event({ body: "synthetic capacity record ".repeat(150) }));
  expect(() => store.append(records)).toThrow("full");
  expect(store.query().events.map(item => item.id)).toEqual([original.id]);
  store.close();
});
