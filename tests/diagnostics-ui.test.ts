import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diagnosticsCopy } from "../launcher/src/diagnostics/copy";

// Real Chromium + React + contracts; the DiagnosticsApi is synthetic. No runtime or account is contacted.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("diagnostics supports localized narrow navigation, paging, and keyboard-safe deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-ui-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/diagnostics.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    for (const language of ["en", "zh-CN", "ja"] as const) {
      const copy = diagnosticsCopy[language];
      const page = await browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.route("http://localhost/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
      await page.goto("http://localhost/diagnostics-fixture");
      await page.evaluate(value => { (window as unknown as { fixture: unknown }).fixture = value; }, { language });
      await page.addStyleTag({ content: readFileSync(join(root, "diagnostics.css"), "utf8") });
      await page.addScriptTag({ content: readFileSync(join(root, "diagnostics.js"), "utf8") });
      expect(errors).toEqual([]);
      await page.getByRole("button", { name: copy.operations, exact: true }).click();
      try { await page.getByRole("button", { name: /A deliberately long supplied/ }).click(); }
      catch (error) { throw new Error(`${String(error)}\nRenderer errors: ${JSON.stringify(errors)}\nVisible state: ${await page.locator("body").innerText()}`); }
      await page.getByRole("heading", { name: copy.timeline }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: copy.back }).click();
      await page.getByRole("button", { name: copy.more, exact: true }).click();
      await page.getByRole("button", { name: /setup stage 109/ }).waitFor();
      // A read-only copy must not discard the loaded page.
      await page.getByRole("button", { name: copy.capture, exact: true }).click();
      await page.getByRole("button", { name: copy.clearNormal }).click();
      const dialog = page.getByRole("dialog", { name: copy.confirmClear });
      await dialog.waitFor();
      expect(await page.getByRole("button", { name: copy.keep }).evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await page.getByRole("button", { name: copy.clearNormal }).evaluate(element => element === document.activeElement)).toBe(true);
      await page.getByRole("button", { name: copy.advanced, exact: true }).click();
      await page.getByRole("searchbox", { name: copy.search }).waitFor();
      for (const width of [320, 640, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        // Native date/time segments and the calendar button must not overlap in a narrow grid cell.
        for (const name of [copy.from, copy.to]) {
          const dateBounds = await page.getByLabel(name, { exact: true }).boundingBox();
          expect(dateBounds).not.toBeNull();
          expect(dateBounds!.width).toBeGreaterThanOrEqual(240);
        }
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("large diagnostic lists remain virtualized and keyboard navigation reaches the final record", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-ui-scale-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/diagnostics.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" }); page.setDefaultTimeout(5000);
    const session = await page.context().newCDPSession(page); await session.send("Performance.enable");
    await page.route("http://localhost/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://localhost/diagnostics-fixture");
    await page.evaluate(() => { (window as unknown as { fixture: unknown }).fixture = { language: "en", eventCount: 1000 }; });
    await page.addStyleTag({ content: readFileSync(join(root, "diagnostics.css"), "utf8") });
    await page.addScriptTag({ content: readFileSync(join(root, "diagnostics.js"), "utf8") });
    await page.getByRole("button", { name: diagnosticsCopy.en.advanced, exact: true }).click();
    await page.getByRole("listitem").first().waitFor();
    for (let count = 200; count <= 1000; count += 100) {
      await page.getByRole("button", { name: diagnosticsCopy.en.more, exact: true }).click();
      await page.waitForFunction(count => document.querySelector('[role="listitem"]')?.getAttribute("aria-setsize") === String(count), count);
    }
    expect(await page.getByRole("listitem").count()).toBeLessThanOrEqual(12);
    const samples: number[] = [];
    await page.getByRole("listitem").first().getByRole("button").focus();
    for (let sample = 0; sample < 10; sample++) {
      const start = performance.now(); await page.keyboard.press("End");
      await page.waitForFunction(() => document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset") === "1000");
      samples.push(performance.now() - start);
      await page.keyboard.press("Home");
      await page.waitForFunction(() => document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset") === "1");
    }
    const metrics = await session.send("Performance.getMetrics");
    console.log(JSON.stringify({ benchmark: "diagnostics-renderer-1000", boundary: "real React/Chromium; synthetic API; Playwright action-to-focus latency", samplesMs: samples, mountedRows: await page.getByRole("listitem").count(), jsHeapUsedBytes: metrics.metrics.find(metric => metric.name === "JSHeapUsedSize")?.value }));
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);

test("foreground search reserves layout, delays cancellation, and background refresh stays quiet", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-ui-timing-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/diagnostics.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost/**", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
    await page.goto("http://localhost/diagnostics-fixture");
    await page.evaluate(() => { (window as unknown as { fixture: unknown }).fixture = { language: "en" }; });
    await page.addStyleTag({ content: readFileSync(join(root, "diagnostics.css"), "utf8") });
    await page.addScriptTag({ content: readFileSync(join(root, "diagnostics.js"), "utf8") });
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByRole("listitem").first().waitFor();
    type Control = { hold: boolean; started: number; startedAt: number; cancelled: number; release(): void; activity(): void };
    const started = await page.evaluate(() => { const c = (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture; c.hold = true; return c.started; });
    const pause = page.getByRole("button", { name: "Pause updates", exact: true });
    const before = await pause.boundingBox();
    await page.getByRole("searchbox", { name: "Search events" }).fill("stage");
    await page.waitForFunction(previous => (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.started > previous, started);
    const cancel = page.getByRole("button", { name: "Cancel search", exact: true });
    expect(await cancel.count()).toBe(0);
    await cancel.waitFor();
    expect(await page.evaluate(() => performance.now() - (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.startedAt)).toBeGreaterThanOrEqual(300);
    expect(await pause.boundingBox()).toEqual(before);
    await cancel.click();
    expect(await cancel.count()).toBe(0);
    expect(await page.getByRole("listitem").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.cancelled)).toBeGreaterThan(0);
    const background = await page.evaluate(() => { const c = (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture; c.activity(); return c.started; });
    await page.waitForFunction(previous => (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.started > previous, background);
    // Observe a held background query beyond the same progress threshold, not a fast completion.
    await page.waitForFunction(() => performance.now() - (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.startedAt >= 300);
    expect(await cancel.count()).toBe(0);
    expect(await pause.boundingBox()).toEqual(before);
    await page.evaluate(() => (window as unknown as { diagnosticsFixture: Control }).diagnosticsFixture.release());
    expect(errors).toEqual([]);
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
