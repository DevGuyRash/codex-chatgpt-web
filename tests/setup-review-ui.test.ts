import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("setup modal renders source evidence, resets approval on protocol change, and supports keyboard cancellation", async () => {
  const output = mkdtempSync(resolve(tmpdir(), "codex-setup-renderer-"));
  let js: string;
  let css: string;
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/setup-review.tsx", "--target", "browser", "--outdir", output], { cwd: resolve("launcher") });
    if (bundle.exitCode !== 0) throw new Error(bundle.stderr.toString());
    js = readFileSync(resolve(output, "setup-review.js"), "utf8");
    css = readFileSync(resolve(output, "setup-review.css"), "utf8");
  } finally { rmSync(output, { recursive: true, force: true }); }
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    for (const cancel of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: js });
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      expect(await dialog.getByRole("cell").filter({ hasText: /Commented out/ }).count()).toBe(1);
      const apply = dialog.getByRole("button", { name: "Approve and continue setup", exact: true });
      expect(await apply.isDisabled()).toBe(true);
      for (const width of [360, 720]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("radio", { name: "Compatibility V1 (Native V2 disabled)", exact: true }).check();
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked);
      expect(await apply.isDisabled()).toBe(true);
      if (process.env.CHATGPT_TEST_SETUP_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_SETUP_SCREENSHOT });
      if (cancel) await page.keyboard.press("Escape");
      else { await dialog.getByRole("checkbox").check(); await apply.click(); }
      await page.getByRole("status").filter({ hasText: cancel ? "Cancelled" : "Approved" }).waitFor();
      expect(await dialog.count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);
