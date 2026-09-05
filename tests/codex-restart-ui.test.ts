import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("restart UI preserves cancellation, explicit confirmation and manual timeout in every language", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-restart-ui-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/restart.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    for (const language of ["en", "zh-CN", "ja"]) {
      const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
      page.setDefaultTimeout(5_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.evaluate(value => { (window as unknown as { language: string }).language = value; }, language);
      await page.addStyleTag({ content: readFileSync(join(root, "restart.css"), "utf8") });
      await page.addScriptTag({ content: readFileSync(join(root, "restart.js"), "utf8") });
      const open = page.getByRole("button", { name: "Open restart" });
      await open.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("checkbox").waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      expect(await open.evaluate(element => element === document.activeElement)).toBe(true);
      expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([]);
      await open.click();
      const later = dialog.getByRole("button", { name: language === "en" ? "Later" : language === "ja" ? "後で" : "稍后", exact: true });
      await later.click();
      expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([]);
      await open.click();
      const restart = dialog.getByRole("button", { name: language === "en" ? "Restart Codex" : language === "ja" ? "Codex を再起動" : "重启 Codex", exact: true });
      expect(await restart.isDisabled()).toBe(true);
      await dialog.getByRole("checkbox").check();
      await restart.click();
      await dialog.getByRole("status").filter({ hasText: "30" }).waitFor();
      expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual(["owned-token"]);
      expect(await restart.isDisabled()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
