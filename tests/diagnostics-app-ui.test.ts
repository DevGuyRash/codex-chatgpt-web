import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type * as Host from "../launcher/diagnostics/host";
import { CaptureCommandSchema, QuerySchema, QueryResultSchema } from "../src/diagnostics/contracts";
import { diagnosticsCopy } from "../launcher/src/diagnostics/copy";

// Real App, emitted host, worker, SQLite and CLI. Test-only HTTP substitutes Electron IPC.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("whole launcher opens a persisted failure and keeps capture controls reachable on narrow layouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-app-"));
  const host = createRequire(import.meta.url)(resolve("launcher/electron/generated/diagnostics.cjs")) as typeof Host;
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await logger.ready;
    await logger.operation("fixture-approval", async () => { throw new host.DiagnosticError({ code: "setup_preview_stale", message: "Synthetic approval failure: review a fresh preview", recovery: "not-needed" }); }).catch(() => {});
    await logger.client!.flush();
    const problem = (await logger.client!.query({ view: "problems" })).events[0].problem!;
    const built = Bun.spawnSync([process.execPath, "build", "tests/fixtures/diagnostics-app.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(built.exitCode).toBe(0);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/diagnostics/status") return Response.json(await logger.client!.status());
      if (url.pathname === "/diagnostics/query") return Response.json(await logger.client!.query(QuerySchema.parse(await request.json())));
      if (url.pathname === "/diagnostics/capture") return Response.json(await logger.client!.capture(CaptureCommandSchema.parse(await request.json())));
      if (url.pathname === "/app.js") return new Response(readFileSync(join(root, "diagnostics-app.js")), { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(readFileSync(join(root, "diagnostics-app.css")), { headers: { "content-type": "text/css" } });
      const fixture = JSON.stringify({ language: url.searchParams.get("language") ?? "en", problem }).replaceAll("<", "\\u003c");
      return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.fixture=${fixture}</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    for (const language of ["en", "zh-CN", "ja"] as const) {
      const copy = diagnosticsCopy[language];
      const page = await browser.newPage({ viewport: { width: 320, height: 800 }, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?language=${language}`);
      const openLabel = language === "en" ? "Open Diagnostics" : language === "zh-CN" ? "打开诊断" : "診断を開く";
      const detailsLabel = language === "en" ? "Details" : language === "zh-CN" ? "详情" : "詳細";
      await page.getByRole("button", { name: `${detailsLabel} (1)`, exact: true }).click();
      try { await page.getByRole("button", { name: openLabel, exact: true }).click(); }
      catch (error) { throw new Error(`${String(error)}\nRenderer errors: ${JSON.stringify(errors)}\nSynthetic visible state: ${(await page.locator("body").innerText()).slice(0, 4000)}`); }
      await page.getByRole("heading", { name: copy.timeline, exact: true }).waitFor();
      try { await page.getByRole("complementary", { name: copy.detail }).getByText(problem.message, { exact: true }).first().waitFor(); }
      catch (error) {
        await page.screenshot({ path: resolve("context/diagnostics-app-failure.png"), fullPage: true });
        throw new Error(`${String(error)}\nSynthetic inspector: ${await page.getByRole("complementary", { name: copy.detail }).innerText()}\nErrors: ${JSON.stringify(errors)}`);
      }
      await page.getByRole("button", { name: copy.capture, exact: true }).click();
      await page.getByRole("checkbox", { name: copy.consent }).check();
      await page.getByRole("button", { name: copy.startPrivate, exact: true }).click();
      await page.locator(".capture-indicator").waitFor();
      await page.getByRole("button", { name: copy.overview, exact: true }).click();
      await page.locator(".capture-indicator").getByRole("button", { name: copy.capture, exact: true }).click();
      await page.getByRole("button", { name: copy.stopPrivate, exact: true }).last().waitFor();
      expect(await page.getByRole("button", { name: copy.capture, exact: true }).last().getAttribute("aria-current")).toBe("page");
      for (const viewport of [{ width: 320, height: 800 }, { width: 640, height: 800 }, { width: 320, height: 350 }]) {
        await page.setViewportSize(viewport);
        await page.getByRole("button", { name: copy.stopPrivate, exact: true }).last().scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await page.locator(".capture-indicator").isVisible()).toBe(true);
      }
      await page.getByRole("button", { name: copy.stopPrivate, exact: true }).last().click();
      await page.locator(".capture-indicator").waitFor({ state: "hidden" });
      expect(errors).toEqual([]); await page.close();
    }
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", root, "diagnostics", "show", problem.traceId!, "--json"], { stdout: "pipe", stderr: "pipe" });
    const output = QueryResultSchema.parse(JSON.parse(await new Response(child.stdout).text()));
    expect(await child.exited).toBe(0);
    expect(output.events.some(event => event.problem?.traceId === problem.traceId && event.problem?.message === problem.message)).toBe(true);
  } finally { await browser.close(); server?.stop(true); await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 45000);
