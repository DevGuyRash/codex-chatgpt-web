import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright-core";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics, runtimeCaptureClient } from "../src/diagnostics/runtime";
import { captureBrowserCheckpoint } from "../src/diagnostics/browser-capture";

test("a failed browser checkpoint survives worker transport as an omission and an incomplete campaign export", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-checkpoint-"));
  const previousWorker = process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER, previousCampaign = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const campaignId = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = crypto.randomUUID();
  const diagnostics = initializeRuntimeDiagnostics({ component: "browser", sink: { emit: event => runtimeCaptureClient()?.emit(event) } })!;
  try {
    const client = runtimeCaptureClient()!;
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000 });
    const operation = diagnostics.begin("browser.fixture");
    const main = {};
    const page = { url: () => "https://chatgpt.com/c/fixture", mainFrame: () => main, frames: () => [main], evaluate: async () => ({ allowed: true, reason: "conversation" }), locator: () => ({ evaluate: async () => ({ x: 0, y: 0, width: 800, height: 600 }) }), screenshot: async () => { throw new Error("Screenshot timed out"); } } as unknown as Page;
    const unloaded = { ...page, url: () => "about:blank" } as Page;
    await operation.run(() => captureBrowserCheckpoint(unloaded, "browser-page-acquired", false, "preflight"));
    expect(await client.contentCapture({ action: "manifest", campaignId })).toMatchObject({ omitted: 0 });
    await operation.run(() => captureBrowserCheckpoint(unloaded, "post-response", false));
    await operation.run(() => captureBrowserCheckpoint(page, "post-response", false));
    let composerVisible = true;
    const changing = { ...page,
      evaluate: async () => ({ allowed: composerVisible, reason: composerVisible ? "conversation" : "composer-unavailable" }),
      screenshot: async () => { composerVisible = false; return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]); },
    } as unknown as Page;
    await operation.run(() => captureBrowserCheckpoint(changing, "turn-completed", false));
    operation.end("succeeded"); await client.flush();
    const exclusions = (await client.query({ view: "events", traceIds: [operation.context.traceId] })).events.filter(event => event.name === "capture.excluded");
    expect(exclusions.find(event => event.attributes.checkpoint === "turn-completed")?.attributes).toMatchObject({ reason: "composer-unavailable", collectionStage: "screenshot-validation", navigationChanged: false });
    await client.contentCapture({ action: "finish", campaignId });
    expect(await client.contentCapture({ action: "manifest", campaignId })).toMatchObject({ omitted: 3 });
    expect(await client.export({ format: "bundle", query: { components: ["unrelated"] }, content: { campaignId, acknowledged: true } }, join(root, "evidence.zip"))).toMatchObject({ incomplete: true });
  } finally {
    await closeRuntimeDiagnostics();
    if (previousWorker === undefined) delete process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER; else process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = previousWorker;
    if (previousCampaign === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = previousCampaign;
    rmSync(root, { recursive: true, force: true });
  }
});
