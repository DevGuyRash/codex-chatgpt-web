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
    for (const outcome of ["approve", "cancel", "cancel-refresh", "blocked"]) {
      const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
      if (outcome === "blocked") await page.goto("about:blank#blocked");
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: js });
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      if (outcome === "blocked") {
        expect(await dialog.getByRole("table").count()).toBe(0);
        expect(await dialog.locator(".diagnostic-findings li").count()).toBe(1);
        expect(await dialog.getByRole("button", { name: "Approve and continue setup", exact: true }).isDisabled()).toBe(true);
        await page.keyboard.press("Escape");
        await page.getByRole("status").filter({ hasText: "Cancelled" }).waitFor();
        expect(errors).toEqual([]);
        await page.close();
        continue;
      }
      const originalDialog = await dialog.elementHandle();
      expect(await dialog.getByRole("cell").filter({ hasText: /Commented out/ }).count()).toBe(1);
      expect(await dialog.getByRole("row").filter({ hasText: "features.multi_agent_v2" }).getByRole("cell").last().textContent()).toBe("Unchanged (true)");
      const apply = dialog.getByRole("button", { name: "Approve and continue setup", exact: true });
      expect(await apply.isDisabled()).toBe(true);
      for (const width of [360, 720]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await dialog.getByRole("checkbox").check();
      await dialog.getByRole("radio", { name: "Compatibility V1 (Native V2 disabled)", exact: true }).check();
      await dialog.getByRole("status").filter({ hasText: "Updating comparison" }).waitFor();
      expect(await originalDialog!.evaluate(element => element.isConnected && (element as HTMLDialogElement).open)).toBe(true);
      expect(await dialog.getByRole("checkbox").isDisabled()).toBe(true);
      expect(await dialog.getByRole("button", { name: "Cancel setup", exact: true }).isEnabled()).toBe(true);
      if (outcome === "cancel-refresh") {
        await page.keyboard.press("Escape");
        await page.getByRole("status").filter({ hasText: "Cancelled" }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new Event("complete-preview")));
        expect(await dialog.count()).toBe(0);
        expect(errors).toEqual([]);
        await page.close();
        continue;
      }
      await page.evaluate(() => window.dispatchEvent(new Event("complete-preview")));
      await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null);
      expect(await originalDialog!.evaluate(element => element.isConnected && (element as HTMLDialogElement).open)).toBe(true);
      const v2 = dialog.getByRole("row").filter({ hasText: "features.multi_agent_v2" });
      expect(await v2.getByRole("cell").allTextContents()).toEqual(["true", "false", "false"]);
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked);
      expect(await apply.isDisabled()).toBe(true);
      if (process.env.CHATGPT_TEST_SETUP_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_SETUP_SCREENSHOT });
      if (outcome === "cancel") await page.keyboard.press("Escape");
      else { await dialog.getByRole("checkbox").check(); await apply.click(); }
      await page.getByRole("status").filter({ hasText: outcome === "cancel" ? "Cancelled" : "Approved" }).waitFor();
      expect(await dialog.count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);
