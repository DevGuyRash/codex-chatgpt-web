import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyFor } from "../launcher/src/i18n";

// Real App and Chromium rendering; launcher state and IPC are synthetic. No ChatGPT access.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("sent handoffs have no countdown and the final MCP step is complete only after verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-launcher-ui-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const built = Bun.spawnSync([process.execPath, "build", "tests/fixtures/diagnostics-app.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(built.exitCode).toBe(0);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/app.js") return new Response(readFileSync(join(root, "diagnostics-app.js")), { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/app.css") return new Response(readFileSync(join(root, "diagnostics-app.css")), { headers: { "content-type": "text/css" } });
      const fixture = { language: url.searchParams.get("language"), problem: { message: "Synthetic fixture" }, upstreamReview: { verified: url.searchParams.get("verified") === "true" } };
      return new Response(`<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.fixture=${JSON.stringify(fixture)}</script><script type="module" src="/app.js"></script>`, { headers: { "content-type": "text/html" } });
    } });
    for (const language of ["en", "zh-CN", "ja"] as const) for (const verified of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      page.setDefaultTimeout(5000);
      await page.goto(`http://127.0.0.1:${server.port}/?language=${language}&verified=${verified}`);
      const guide = page.locator(".manual-turn-guide");
      await guide.waitFor();
      const copy = copyFor(language);
      expect(await guide.innerText()).not.toContain(`0 ${copy.manualPromptSeconds}`);
      expect(await guide.innerText()).toContain(copy.manualPromptSent);
      await page.getByRole("button", { name: "MCP", exact: true }).click();
      const finalStep = page.getByRole("button").filter({ has: page.getByText(copy.mcpStepThree, { exact: true }) });
      await finalStep.waitFor();
      // is-complete is the visual completion treatment; this fixes its disagreement with the check icon.
      expect((await finalStep.getAttribute("class"))?.includes("is-complete")).toBe(verified);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); server?.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 30000);
