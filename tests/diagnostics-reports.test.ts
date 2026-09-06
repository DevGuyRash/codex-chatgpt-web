import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../src/diagnostics/store";
import { exportDiagnostics } from "../src/diagnostics/export";
import { assembleReport, copyReport } from "../src/diagnostics/report";
import { requestFailure, unwrapDiagnosticResult } from "../src/diagnostics/request-error";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";

test("explicit operation export selects every correlated page, not unrelated records", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-reports-"));
  const directory = join(root, "store"), destination = join(root, "report.json");
  const store = new DiagnosticStore(directory);
  const traceId = "a".repeat(32);
  const event = (index: number): DiagnosticEvent => ({ version: 1, id: crypto.randomUUID(), time: Date.now() + index, name: "fixture", kind: "log", severity: "info", body: "Fixture", component: "fixture", environment: "test", target: "base", traceId, attributes: {} });
  try {
    const events = [...Array.from({ length: 225 }, (_, index) => event(index)), { ...event(226), traceId: "b".repeat(32) }];
    for (let offset = 0; offset < events.length; offset += 128) store.append(events.slice(offset, offset + 128));
    const result = await exportDiagnostics(directory, { format: "json", selection: { kind: "operation", traceId } }, destination);
    const report = JSON.parse(readFileSync(destination, "utf8"));
    expect(result.records).toBe(225);
    expect(report.events.every((item: DiagnosticEvent) => item.traceId === traceId)).toBe(true);
    expect(report.privateCapturesIncluded).toBe(false);
    const copied = await copyReport(directory, { format: "json", selection: { kind: "operation", traceId } });
    expect(JSON.parse(copied.text).events).toEqual(report.events);
    const limited = await assembleReport(directory, { kind: "all" }, { records: 2, bytes: 10_000 });
    expect(limited.records).toBe(2);
    expect(limited.incomplete).toBe(true);
    expect(limited.notices.join(" ")).toContain("size limit");
    const missing = await assembleReport(directory, { kind: "event", eventId: crypto.randomUUID() });
    expect(missing.incomplete).toBe(true);
    expect(missing.records).toBe(0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("serializable diagnostic failures preserve cancellation without arbitrary error content", () => {
  const error = Object.assign(new Error("private input"), { name: "AbortError" });
  const serialized = JSON.parse(JSON.stringify(requestFailure(error, "query_failed")));
  expect(JSON.stringify(serialized)).not.toContain("private input");
  expect(() => unwrapDiagnosticResult(serialized)).toThrow("Diagnostic request cancelled");
  try { unwrapDiagnosticResult(serialized); } catch (error) { expect((error as Error).name).toBe("AbortError"); }
});
