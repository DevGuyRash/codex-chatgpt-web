import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics, runtimeCaptureClient } from "../src/diagnostics/runtime";
import { TurnBroker, callTurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { createFormatFixtures } from "../scripts/golden/formats";

for (const limitedCapture of [false, true]) test(`scoped broker capture retains owned multimodal replies and preserves delivery when capture is omitted: ${limitedCapture}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-tools-")), socket = join(root, "broker.sock");
  const previousWorker = process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER, previousCampaign = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const campaignId = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = crypto.randomUUID();
  const diagnostics = initializeRuntimeDiagnostics({ component: "runtime", sink: { emit: event => runtimeCaptureClient()?.emit(event) } })!;
  const broker = TurnBroker.forSocket(socket);
  try {
    const client = runtimeCaptureClient()!;
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000, ...(limitedCapture ? { maxBytes: 1024 } : {}) });
    const operations = [diagnostics.begin("http.responses", {}, null), diagnostics.begin("http.responses", {}, null)];
    const pending = await Promise.all(operations.map(async (operation, index) => {
      const token = await operation.run(() => broker.register({ cwd: root, roots: [root], writableRoots: [root], sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false }, tools: [] }, 10000));
      const binding = await callTurnBroker<{ bindingId: string }>(socket, { method: "claim", token });
      const invocation = callTurnBroker<BrokerToolResult>(socket, { method: "invoke", bindingId: binding.bindingId, wireName: "view_image", freeform: false, arguments: { path: `/fixture/${index}.png` } }, 10000);
      const [request] = await broker.nextToolBatch(token);
      const result: BrokerToolResult = { content: [{ type: "image", mimeType: "image/png", data: Buffer.from(createFormatFixtures(String(index), true).files["input/label.png"]!).toString("base64") }, { type: "text", text: `Synthetic image ${index}: <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>` }] };
      return { token, request: request!, result, invocation, traceId: operation.context.traceId };
    }));
    // Completion originates outside both submitting contexts and arrives in reverse order.
    for (const item of [...pending].reverse()) {
      await broker.completeTool(item.token, item.request.callId, item.result);
      expect(await item.invocation).toEqual(item.result);
    }
    operations.forEach(operation => operation.end()); await broker.close(); await client.flush();
    await client.contentCapture({ action: "finish", campaignId });
    const path = join(root, "evidence.zip");
    expect(await client.export({ format: "bundle", selection: { kind: "selection", traceIds: pending.map(item => item.traceId) }, content: { campaignId, acknowledged: true } }, path)).toMatchObject({ incomplete: limitedCapture });
    const files = unzipSync(readFileSync(path)), manifest = JSON.parse(strFromU8(files["content/manifest.json"]!));
    const results = manifest.attachments.filter((item: { category: string }) => item.category === "tool-result");
    if (limitedCapture) {
      expect(results).toHaveLength(0);
      expect(manifest.omitted).toBe(2);
      expect(manifest.attachments.every((item: { category: string }) => item.category === "tool-arguments")).toBe(true);
      return;
    }
    expect(results).toHaveLength(2);
    for (const item of pending) {
      const stored = results.find((attachment: { traceId: string }) => attachment.traceId === item.traceId);
      expect(JSON.parse(strFromU8(files[stored.file]!))).toEqual({ callId: item.request.callId, tool: "view_image", result: item.result });
      expect(manifest.attachments.some((attachment: { traceId: string; category: string }) => attachment.traceId === item.traceId && attachment.category === "tool-arguments")).toBe(true);
    }
  } finally {
    await broker.close(); await closeRuntimeDiagnostics();
    if (previousWorker === undefined) delete process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER; else process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = previousWorker;
    if (previousCampaign === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = previousCampaign;
    rmSync(root, { recursive: true, force: true });
  }
});
