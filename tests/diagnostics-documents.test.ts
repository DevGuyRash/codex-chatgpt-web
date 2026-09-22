import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { DiagnosticStore } from "../src/diagnostics/store";
import { captureDocument } from "../src/diagnostics/document-capture";
import { exportDiagnostics } from "../src/diagnostics/export";
import { ContentCaptureResultSchema, DiagnosticEventSchema } from "../src/diagnostics/contracts";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

test("large scoped documents are scrubbed as a whole, retained in bounded attachments and exported with complete integrity", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-")), store = new DiagnosticStore(join(root, "store"));
  const campaignId = randomUUID(), traceId = "a".repeat(32);
  const client = { contentCapture: async (command: Parameters<DiagnosticStore["contentCapture"]>[0]) => ContentCaptureResultSchema.parse(store.contentCapture(command)) };
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    const text = JSON.stringify({ prefix: "東京🌵".repeat(160000), password: "synthetic secret crossing a transport chunk", result: "9007199254740993" });
    const result = await captureDocument(client, { campaignId, traceId, category: "transport", text });
    expect(result).toMatchObject({ status: "stored-document" });
    const manifest = store.contentManifest(campaignId);
    expect(manifest.documents).toHaveLength(1);
    expect(manifest.documents[0]).toMatchObject({ status: "stored", chunks: expect.any(Number) });
    expect(manifest.attachments.every(item => item.bytes <= 1024 * 1024)).toBe(true);
    expect(manifest.attachments.length).toBeGreaterThan(1);
    store.contentCapture({ action: "finish", campaignId });
    const output = join(root, "evidence.zip");
    expect(await exportDiagnostics(join(root, "store"), { format: "bundle", content: { campaignId, acknowledged: true } }, output)).toMatchObject({ incomplete: false });
    const bundle = unzipSync(readFileSync(output));
    const exported = JSON.parse(strFromU8(bundle["content/manifest.json"]!));
    const assembled = exported.attachments.sort((a: any, b: any) => a.document.index - b.document.index).map((item: any) => strFromU8(bundle[item.file]!)).join("");
    expect(assembled).toBe(text.replace("synthetic secret crossing a transport chunk", "[redacted]"));
    expect(createHash("sha256").update(assembled).digest("hex")).toBe(exported.documents[0].sha256);
    const originalBundle = readFileSync(output), corrupt = new Database(join(root, "store/diagnostics.sqlite"));
    try { corrupt.query("UPDATE capture_documents SET sha256=? WHERE campaign_id=?").run("0".repeat(64), campaignId); } finally { corrupt.close(); }
    await expect(exportDiagnostics(join(root, "store"), { format: "bundle", content: { campaignId, acknowledged: true } }, output)).rejects.toThrow("complete-content integrity");
    expect(readFileSync(output)).toEqual(originalBundle);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("interrupted document uploads survive restart as incomplete evidence without persisting raw partial content", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-interrupted-"));
  let store = new DiagnosticStore(join(root, "store"));
  const campaignId = randomUUID(), traceId = "b".repeat(32), documentId = randomUUID();
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    expect(store.contentCapture({ action: "document-start", campaignId, traceId, documentId, category: "transport", bytes: 1024 })).toMatchObject({ status: "receiving" });
    store.contentCapture({ action: "document-part", campaignId, traceId, documentId, index: 0, text: '{"password":"unpersisted synthetic credential' });
    store.close(); store = new DiagnosticStore(join(root, "store"));
    expect(store.contentManifest(campaignId)).toMatchObject({ attachments: [], documents: [{ id: documentId, status: "receiving" }] });
    store.contentCapture({ action: "finish", campaignId });
    expect(await exportDiagnostics(join(root, "store"), { format: "bundle", query: { components: ["unrelated"] }, content: { campaignId, acknowledged: true } }, join(root, "incomplete.zip"))).toMatchObject({ incomplete: true });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("document capture refuses authentication content even when sensitive keys cross transport parts", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-auth-")), store = new DiagnosticStore(root);
  const campaignId = randomUUID(), traceId = "c".repeat(32), documentId = randomUUID();
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    const parts = ['{"access_', 'token":"synthetic auth value"}'];
    store.contentCapture({ action: "document-start", campaignId, traceId, documentId, category: "transport", bytes: Buffer.byteLength(parts.join("")) });
    parts.forEach((text, index) => store.contentCapture({ action: "document-part", campaignId, traceId, documentId, index, text }));
    expect(store.contentCapture({ action: "document-finish", campaignId, traceId, documentId })).toMatchObject({ status: "omitted", reason: "authentication-content" });
    expect(store.contentManifest(campaignId)).toMatchObject({ omitted: 1, attachments: [], documents: [{ status: "omitted" }] });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("large Unicode documents cross the actual diagnostics worker without enlarging its message limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-worker-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const campaignId = randomUUID(), traceId = "d".repeat(32);
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    await client.contentCapture({ action: "bind", campaignId, traceId });
    const body = "東京🌵 café ".repeat(200);
    for (let index = 0; index < 50; index++) client.emit(DiagnosticEventSchema.parse({ version: 1, id: randomUUID(), time: Date.now(), kind: "log", name: "document.unicode", body, severity: "info", component: "fixture", environment: "test", target: "synthetic", traceId }));
    await client.flush();
    const observed = (await client.query({ traceId, limit: 200 })).events;
    expect(observed).toHaveLength(50);
    expect(observed.every(event => event.body === body)).toBe(true);
    const text = "東京🌵\n".repeat(150000);
    expect(await captureDocument(client, { campaignId, traceId, category: "oracle", text })).toMatchObject({ status: "stored-document", bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
    await client.contentCapture({ action: "finish", campaignId });
    expect(await client.export({ format: "bundle", content: { campaignId, acknowledged: true } }, join(root, "document.zip"))).toMatchObject({ incomplete: false });
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("document reservations are bounded and explicit abort releases their memory and storage admission", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-budget-")), store = new DiagnosticStore(root);
  const campaignId = randomUUID(), traceId = "e".repeat(32), documentId = randomUUID();
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    store.contentCapture({ action: "document-start", campaignId, traceId, documentId, category: "output", bytes: 64 * 1024 * 1024 });
    expect(store.contentCapture({ action: "document-start", campaignId, traceId, documentId: randomUUID(), category: "output", bytes: 1 })).toMatchObject({ status: "omitted", reason: "storage-budget" });
    expect(store.contentCapture({ action: "document-abort", campaignId, traceId, documentId })).toMatchObject({ status: "omitted", reason: "capture-failed" });
    expect(store.contentCapture({ action: "document-start", campaignId, traceId, documentId: randomUUID(), category: "output", bytes: 1 })).toMatchObject({ status: "receiving" });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("schema-three capture evidence survives the document migration", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-document-migration-"));
  let store = new DiagnosticStore(root);
  const campaignId = randomUUID(), traceId = "f".repeat(32);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    store.contentCapture({ action: "write", campaignId, traceId, category: "oracle", text: "Earlier retained evidence" });
    store.close();
    const previous = new Database(join(root, "diagnostics.sqlite"));
    try { previous.exec("DROP TABLE capture_collection_windows; DROP INDEX capture_content_capacity; DROP INDEX capture_content_document_part; ALTER TABLE capture_content DROP COLUMN document_id; ALTER TABLE capture_content DROP COLUMN document_index; DROP TABLE capture_documents; PRAGMA user_version=3"); }
    finally { previous.close(); }
    store = new DiagnosticStore(root);
    expect([...store.contentAttachments(campaignId, true)].map(item => item.text)).toEqual(["Earlier retained evidence"]);
    expect(store.contentManifest(campaignId).documents).toEqual([]);
    expect(store.status().schemaVersion).toBe(6);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
