import { expect, test } from "bun:test";
import { type Page } from "playwright-core";
import { isPrivateCaptureSurface } from "../src/diagnostics/browser-capture";
import { captureBrowserCheckpoint } from "../src/diagnostics/browser-capture";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics, runtimeCaptureClient } from "../src/diagnostics/runtime";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { captureCampaignContent, omitCampaignCapture } from "../src/diagnostics/campaign-capture";

test("private capture denies authentication, settings, embedded frames, and unavailable inspection", async () => {
  let inspections = 0;
  const main = {};
  const page = (url: string, frames = 1, safe = true) => ({ url: () => url, mainFrame: () => main, frames: () => [main, ...Array.from({ length: frames - 1 }, () => ({ frameElement: async () => ({ isVisible: async () => true, dispose: async () => {} }) }))], evaluate: async () => { inspections++; return { allowed: safe, reason: safe ? "conversation" : "visible-sensitive-control" }; } }) as unknown as Page;
  for (const url of ["https://auth.openai.com/", "https://chatgpt.com/auth/login", "https://chatgpt.com/settings", "https://example.com/"]) expect(await isPrivateCaptureSurface(page(url))).toBe(false);
  expect(inspections).toBe(0);
  expect(await isPrivateCaptureSurface(page("https://chatgpt.com/c/fixture", 2))).toBe(false);
  expect(await isPrivateCaptureSurface(page("https://chatgpt.com/c/fixture", 1, false))).toBe(false);
  expect(await isPrivateCaptureSurface(page("https://chatgpt.com/c/fixture"))).toBe(true);
  expect(await isPrivateCaptureSurface({ url: () => "https://chatgpt.com/", frames: () => [1], evaluate: async () => { throw new Error("closed"); } } as unknown as Page)).toBe(false);
});


test("shared capture control admits only an explicitly scoped image and normal records contain no image bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-capture-"));
  const previous = process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER;
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const events: DiagnosticEvent[] = [];
  const diagnostics = initializeRuntimeDiagnostics({ component: "browser", sink: { emit: event => events.push(event) } })!;
  const operation = diagnostics.begin("browser.fixture");
  let screenshots = 0; let safeSurface = true;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const main = {};
  const page = { url: () => "https://chatgpt.com/c/fixture", mainFrame: () => main, frames: () => [main], evaluate: async () => ({ allowed: safeSurface, reason: safeSurface ? "conversation" : "visible-sensitive-control" }), screenshot: async () => { screenshots++; return png; } } as unknown as Page;
  try {
    await operation.run(() => captureBrowserCheckpoint(page, "default", false));
    expect(screenshots).toBe(0);
    const client = runtimeCaptureClient()!;
    await client.capture({ action: "private-start", scope: "next-browser-turn", acknowledged: true });
    safeSurface = false;
    await operation.run(() => captureBrowserCheckpoint(page, "blocked-surface", false));
    expect(screenshots).toBe(0);
    safeSurface = true;
    await operation.run(() => captureBrowserCheckpoint(page, "approved-surface", false));
    expect(screenshots).toBe(1);
    expect((await client.status()).privateBytes).toBe(png.byteLength);
    await client.capture({ action: "private-stop" });
    await operation.run(() => captureBrowserCheckpoint(page, "stopped", false));
    expect(screenshots).toBe(1);
    expect(events.some(event => event.name === "capture.result")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(png.toString("base64"));
  } finally {
    await closeRuntimeDiagnostics();
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER; else process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("campaign capture failures retain typed worker details through an independent collection worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-capture-failure-"));
  const previousWorker = process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER, previousCampaign = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  const script = `const { DiagnosticStore } = await import(${JSON.stringify(resolve("src/diagnostics/store.ts"))}); const original = DiagnosticStore.prototype.contentCapture; DiagnosticStore.prototype.contentCapture = function(command) { if (command.action === "write") Bun.sleepSync(6000); return original.call(this, command); }; const { runDiagnosticsWorker } = await import(${JSON.stringify(resolve("src/diagnostics/worker.ts"))}); await runDiagnosticsWorker(${JSON.stringify(join(root, "diagnostics", "observability"))});`;
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify({ executable: process.execPath, args: ["-e", script] });
  const campaignId = crypto.randomUUID(); process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = campaignId;
  const sink = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = initializeRuntimeDiagnostics({ component: "browser-helper", sink })!;
  const operation = diagnostics.begin("capture.fixture", {}, null, { id: "native-capture-fixture" });
  const payload = "synthetic-private-payload-must-stay-out-of-errors";
  try {
    const control = runtimeCaptureClient()!;
    await control.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 60000, maxBytes: 1048576 });
    await captureCampaignContent("transport", payload, operation.context);
    await omitCampaignCapture("capture-failed", operation.context);
    operation.end(); await sink.flush();
    const events = (await sink.query({ traceId: operation.context.traceId, limit: 20 })).events;
    const failure = events.find(event => event.kind === "problem" && event.problem?.code === "timeout");
    expect(failure).toMatchObject({ traceId: operation.context.traceId, spanId: operation.context.spanId, taskId: "native-capture-fixture", problem: { stage: "capture.content", origin: "diagnostics" } });
    const findings = JSON.stringify(failure?.problem?.findings);
    expect(findings).toContain("method=content-capture");
    expect(findings).toContain("action=write");
    expect(findings).toContain("workerElapsedMs=");
    expect(findings).toContain("inputWriteCompleted=true");
    expect(events.some(event => event.name === "capture.campaign_failed" && event.attributes.problemCode === "timeout")).toBe(true);
    expect(events.some(event => event.problem?.code === "unavailable" && event.problem.stage === "capture.omission")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(payload);
  } finally {
    await closeRuntimeDiagnostics(); await sink.close();
    if (previousWorker === undefined) delete process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER; else process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = previousWorker;
    if (previousCampaign === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = previousCampaign;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
