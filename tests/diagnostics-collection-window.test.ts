import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { DiagnosticStore } from "../src/diagnostics/store";
import { exportDiagnostics } from "../src/diagnostics/export";
import { ContentManifestSchema, reportedCaptureDrops, type DiagnosticEvent } from "../src/diagnostics/contracts";

function event(traceId: string): DiagnosticEvent {
  return { version: 1, id: randomUUID(), time: Date.now(), kind: "log", name: "fixture.collection-window", body: "Synthetic retained evidence", severity: "info", component: "test", environment: "test", target: "fixture", traceId, attributes: {} };
}

test("closed capture loss boundaries survive re-export and do not alter the lifetime counter", async () => {
  const directory = mkdtempSync(join(tmpdir(), "diagnostic-collection-window-")), store = new DiagnosticStore(directory);
  const first = randomUUID(), second = randomUUID(), traceId = "a".repeat(32);
  const destination = join(tmpdir(), `${randomUUID()}.zip`);
  try {
    store.dropped(3);
    store.contentCapture({ action: "start", campaignId: first, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId: first, traceId });
    store.append([event(traceId)]);
    store.contentCapture({ action: "finish", campaignId: first });
    const closed = store.contentManifest(first).collectionWindow!;
    expect(closed).toMatchObject({ startDropped: 3, endDropped: 3, currentDropped: 3 });
    store.contentCapture({ action: "start", campaignId: second, acknowledged: true, until: Date.now() + 60000 });
    const otherWriter = new DiagnosticStore(directory);
    try { otherWriter.dropped(2); } finally { otherWriter.close(); }
    store.contentCapture({ action: "finish", campaignId: second });
    store.contentCapture({ action: "finish", campaignId: first });
    expect(store.contentManifest(first).collectionWindow).toEqual({ ...closed, currentDropped: 5 });
    expect(reportedCaptureDrops(store.contentManifest(first).collectionWindow)).toBe(0);
    expect(reportedCaptureDrops(store.contentManifest(second).collectionWindow)).toBe(2);
    expect(store.status().dropped).toBe(5);
    const exported = await exportDiagnostics(directory, { format: "bundle", selection: { kind: "selection", traceIds: [traceId] }, content: { campaignId: first, acknowledged: true } }, destination);
    expect(exported.incomplete).toBe(false);
    const report = JSON.parse(strFromU8(unzipSync(readFileSync(destination))["manifest.json"]!));
    expect(report.collectionHealth.dropped).toBe(5);
    expect(report.collectionScope).toMatchObject({ campaignId: first, reportedDrops: 0, startDropped: 3, endDropped: 3 });
    expect(report.notices.join(" ")).toContain("lifetime counter remains 5");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); rmSync(destination, { force: true }); }
});

for (const outside of ["before", "after", "unbound", "unscoped"] as const) test(`campaign loss boundaries cannot conceal ${outside} selected evidence`, async () => {
  const directory = mkdtempSync(join(tmpdir(), "diagnostic-collection-selection-")), store = new DiagnosticStore(directory);
  const campaignId = randomUUID(), traceId = "b".repeat(32), otherTrace = "c".repeat(32);
  const destination = join(tmpdir(), `${randomUUID()}.zip`);
  try {
    store.dropped(3);
    if (outside === "before") store.append([event(traceId)]);
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    store.append([event(traceId)]);
    if (outside === "unbound") store.append([event(otherTrace)]);
    store.contentCapture({ action: "finish", campaignId });
    if (outside === "after") store.append([event(traceId)]);
    const result = await exportDiagnostics(directory, { format: "bundle", selection: outside === "unscoped" ? { kind: "all" } : { kind: "selection", traceIds: outside === "unbound" ? [traceId, otherTrace] : [traceId] }, content: { campaignId, acknowledged: true } }, destination);
    expect(result.incomplete).toBe(true);
    const report = JSON.parse(strFromU8(unzipSync(readFileSync(destination))["manifest.json"]!));
    expect(report.collectionScope).toBeNull();
    expect(report.collectionHealth.dropped).toBe(3);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); rmSync(destination, { force: true }); }
});

test("schema-five campaigns retain their evidence and an unknown collection boundary after migration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "diagnostic-collection-legacy-"));
  let store = new DiagnosticStore(directory);
  const campaignId = randomUUID(), traceId = "d".repeat(32), destination = join(tmpdir(), `${randomUUID()}.zip`);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    store.append([event(traceId)]);
    store.contentCapture({ action: "write", campaignId, traceId, category: "prompt", text: "Synthetic legacy evidence" });
    store.contentCapture({ action: "finish", campaignId });
    const before = store.contentManifest(campaignId);
    store.close();
    const previous = new Database(join(directory, "diagnostics.sqlite"));
    try { previous.exec("DROP TABLE capture_collection_windows; PRAGMA user_version=5"); } finally { previous.close(); }
    store = new DiagnosticStore(directory);
    expect(store.contentManifest(campaignId)).toEqual({ ...before, collectionWindow: null });
    store.contentCapture({ action: "finish", campaignId });
    expect(store.contentManifest(campaignId).collectionWindow).toBeNull();
    expect((await exportDiagnostics(directory, { format: "bundle", selection: { kind: "selection", traceIds: [traceId] }, content: { campaignId, acknowledged: true } }, destination)).incomplete).toBe(true);
    const bundle = unzipSync(readFileSync(destination));
    expect(strFromU8(bundle["manifest.json"]!)).toContain("no valid recorded collection-loss boundary");
    const manifest = ContentManifestSchema.parse(JSON.parse(strFromU8(bundle["content/manifest.json"]!)));
    expect(manifest.attachments).toHaveLength(1);
    expect(manifest.collectionWindow).toBeNull();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); rmSync(destination, { force: true }); }
});

test("missing or inconsistent collection counter observations cannot assert zero loss", () => {
  const window = { startSequence: 0, startDropped: 3, endSequence: null, endDropped: null, currentDropped: 3 };
  expect(reportedCaptureDrops(null)).toBeNull();
  expect(reportedCaptureDrops({ ...window, currentDropped: 2 })).toBeNull();
  expect(reportedCaptureDrops({ ...window, currentDropped: NaN })).toBeNull();
  expect(reportedCaptureDrops({ ...window, endSequence: 1 })).toBeNull();
  expect(reportedCaptureDrops({ ...window, endSequence: 1, endDropped: 4 })).toBeNull();
});
