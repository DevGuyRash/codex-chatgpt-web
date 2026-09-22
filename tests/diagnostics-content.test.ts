import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { DiagnosticStore } from "../src/diagnostics/store";
import { exportDiagnostics } from "../src/diagnostics/export";
import { DiagnosticEventSchema } from "../src/diagnostics/contracts";

test("admitted campaigns above 64 MiB export completely and clearing them preserves unrelated fresh evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-content-large-"));
  const directory = join(root, "store"), store = new DiagnosticStore(directory);
  const campaignId = crypto.randomUUID(), traceId = "c".repeat(32);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 86400000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    for (let index = 0; index < 66; index++) expect(store.contentCapture({ action: "write", campaignId, traceId, category: "tool-result", text: String(index).padStart(6, "0") + "x".repeat(1024 * 1024 - 6) })).toMatchObject({ status: "stored" });
    store.contentCapture({ action: "finish", campaignId });
    const fresh = DiagnosticEventSchema.parse({ version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "log", name: "fresh.evidence", body: "Unrelated retained evidence", severity: "info", component: "runtime", environment: "test", target: "base", attributes: {} });
    store.append([fresh]);
    const destination = join(root, "large.zip");
    const exported = await exportDiagnostics(directory, { format: "bundle", content: { campaignId, acknowledged: true } }, destination);
    expect(exported).toMatchObject({ files: 73, incomplete: false });
    const bundle = unzipSync(readFileSync(destination));
    const manifest = JSON.parse(strFromU8(bundle["content/manifest.json"]!));
    expect(manifest.attachments).toHaveLength(66);
    for (const attachment of manifest.attachments) expect(createHash("sha256").update(bundle[attachment.file]!).digest("hex")).toBe(attachment.fileSha256);
    store.clear("private", true);
    store.prune();
    expect(store.query().events.map(event => event.id)).toContain(fresh.id);
    expect(store.status().bytes).toBeLessThan(store.status().retention.bytes);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("campaign content redacts quoted and nested JSON credentials without losing noncredential fields", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-content-json-")), store = new DiagnosticStore(root);
  const campaignId = crypto.randomUUID(), traceId = "b".repeat(32);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 86400000, maxBytes: 4096 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    for (const text of [
      '{"password":"private password with spaces","api_key":"private-api-key","result":42}',
      JSON.stringify({ output: JSON.stringify({ password: 'private "quoted" password', apiKey: "private-camel-key", result: 42 }) }),
      'Tool output: {"password": "private embedded password", "result":42}',
    ]) expect(store.contentCapture({ action: "write", campaignId, traceId, category: "tool-result", text })).toMatchObject({ status: "stored" });
    for (const attachment of store.contentAttachments(campaignId, true)) {
      expect(attachment.text).not.toContain("private");
      expect(attachment.text).toContain("42");
      expect(attachment.text).toContain("[redacted]");
    }
    const exact = '{ "integer":9007199254740993, "value":1e400, "decimal":1.0000000000000000001, "password":"private number test" }';
    store.contentCapture({ action: "write", campaignId, traceId, category: "tool-result", text: exact });
    expect([...store.contentAttachments(campaignId, true)].some(item => item.text === exact.replace('"private number test"', '"[redacted]"'))).toBe(true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("campaign URL sanitization preserves escaped XML and nested JSON while removing URL credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-content-urls-")), store = new DiagnosticStore(root);
  const campaignId = crypto.randomUUID(), traceId = "d".repeat(32);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 86400000 });
    store.contentCapture({ action: "bind", campaignId, traceId });
    const xml = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/></worksheet>';
    let text = JSON.stringify({ callId: "fixture", result: { content: [{ type: "text", text: xml }] } });
    for (let depth = 0; depth < 3; depth++) {
      const stored = store.contentCapture({ action: "write", campaignId, traceId, category: "tool-result", text }) as { id: string };
      expect([...store.contentAttachments(campaignId, true)].find(item => item.id === stored.id)?.text).toBe(text);
      text = JSON.stringify({ nested: text });
    }
    const sensitive = JSON.stringify({ text: '<link href="https://fixture-user:fixture-password@example.test/path?private=query#fragment">Synthetic link</link>' });
    const stored = store.contentCapture({ action: "write", campaignId, traceId, category: "tool-result", text: sensitive }) as { id: string };
    expect(JSON.parse([...store.contentAttachments(campaignId, true)].find(item => item.id === stored.id)!.text!)).toEqual({ text: '<link href="https://example.test/path">Synthetic link</link>' });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("scoped content requires binding, preserves useful content, redacts credentials and exports only on explicit request", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-content-"));
  const directory = join(root, "store"), store = new DiagnosticStore(directory);
  const campaignId = crypto.randomUUID(), traceId = "a".repeat(32);
  try {
    store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 86400000, maxBytes: 4096 });
    const write = { action: "write" as const, campaignId, traceId, category: "tool-result" as const, text: "Synthetic result: 42\nBearer private-access-key" };
    expect(() => store.contentCapture(write)).toThrow("outside this capture scope");
    store.contentCapture({ action: "bind", campaignId, traceId });
    expect(store.contentCapture(write)).toMatchObject({ status: "stored", sha256: expect.any(String) });
    expect(store.contentCapture({ ...write, text: "x".repeat(4096) })).toEqual({ status: "omitted", reason: "storage-budget" });
    expect(store.contentCapture({ ...write, text: '{"cookies":[]}' })).toMatchObject({ reason: "authentication-content" });
    expect(store.contentManifest(campaignId)).toMatchObject({ omitted: 2 });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA8sAAAAASUVORK5CYII=", "base64");
    store.contentCapture({ ...write, category: "screenshot", text: png.toString("base64") });
    const ordinary = join(root, "ordinary.zip"), scoped = join(root, "scoped.zip");
    await exportDiagnostics(directory, { format: "bundle" }, ordinary);
    expect(Object.keys(unzipSync(readFileSync(ordinary))).some(key => key.startsWith("content/"))).toBe(false);
    const exported = await exportDiagnostics(directory, { format: "bundle", content: { campaignId, acknowledged: true } }, scoped);
    expect(exported.incomplete).toBe(true);
    const bundle = unzipSync(readFileSync(scoped));
    expect(JSON.parse(strFromU8(bundle["manifest.json"]!))).toMatchObject({ scopedContentIncluded: true, scopedContent: { campaignId, omitted: 2, attachments: 2 } });
    const manifest = JSON.parse(strFromU8(bundle["content/manifest.json"]!));
    for (const attachment of manifest.attachments) {
      expect(bundle[attachment.file]!.byteLength).toBe(attachment.fileBytes);
      expect(createHash("sha256").update(bundle[attachment.file]!).digest("hex")).toBe(attachment.fileSha256);
    }
    const content = Object.entries(bundle).filter(([key]) => key.endsWith(".txt")).map(([, data]) => strFromU8(data)).join("\n");
    expect(content).toContain("Synthetic result: 42"); expect(content).not.toContain("private-access-key");
    expect(() => store.clear("normal", true)).toThrow("Finish active capture");
    store.contentCapture({ action: "finish", campaignId });
    expect(() => store.contentCapture(write)).toThrow("not active");
    store.clear("normal", true);
    store.clear("private", true);
    expect(() => store.contentManifest(campaignId)).toThrow("unavailable");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
