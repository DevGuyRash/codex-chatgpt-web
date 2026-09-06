import { expect, test } from "bun:test";
import { type Page } from "playwright-core";
import { isPrivateCaptureSurface } from "../src/diagnostics/browser-capture";
import { captureBrowserCheckpoint } from "../src/diagnostics/browser-capture";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics, runtimeCaptureClient } from "../src/diagnostics/runtime";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("private capture denies authentication, settings, embedded frames, and unavailable inspection", async () => {
  let inspections = 0;
  const page = (url: string, frames = 1, safe = true) => ({ url: () => url, frames: () => Array(frames), evaluate: async () => { inspections++; return safe; } }) as unknown as Page;
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
  const page = { url: () => "https://chatgpt.com/c/fixture", frames: () => [1], evaluate: async () => safeSurface, screenshot: async () => { screenshots++; return png; } } as unknown as Page;
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
