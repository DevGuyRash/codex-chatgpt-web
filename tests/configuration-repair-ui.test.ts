import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// This proves rendered approval controls, not Electron IPC or live installation.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("repair UI requires explicit protocol and approval, invalidating rejected previews", async () => {
  const output = mkdtempSync(resolve(tmpdir(), "codex-repair-renderer-"));
  let js: string;
  let css: string;
  try {
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/repair.tsx", "--target", "browser", "--outdir", output], { cwd: resolve("launcher") });
    if (bundle.exitCode !== 0) throw new Error(bundle.stderr.toString());
    js = readFileSync(resolve(output, "repair.js"), "utf8");
    css = readFileSync(resolve(output, "repair.css"), "utf8");
  } finally { rmSync(output, { recursive: true, force: true }); }
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    const protocol = page.getByRole("group", { name: "Subagent protocol", exact: true });
    const native = protocol.getByRole("radio", { name: "Native (preserve newer feature choices)", exact: true });
    const compatibility = protocol.getByRole("radio", { name: "Compatibility V1 (Native V2 disabled)", exact: true });
    const preview = page.getByRole("button", { name: "Preview changes", exact: true });
    await protocol.waitFor();
    expect(await native.isChecked()).toBe(false);
    expect(await compatibility.isChecked()).toBe(false);
    expect(await preview.isDisabled()).toBe(true);
    for (const width of [360, 720]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await native.isVisible()).toBe(true);
      expect(await compatibility.isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await native.check();
    if (process.env.CHATGPT_TEST_REPAIR_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_REPAIR_SCREENSHOT });
    await preview.click();
    const apply = page.getByRole("button", { name: "Apply approved repair", exact: true });
    await apply.waitFor();
    expect(await apply.isDisabled()).toBe(true);
    expect(await page.getByRole("cell", { name: "native", exact: true }).count()).toBe(1);
    await page.getByRole("checkbox").check();
    const callsBeforeCollapse = await page.evaluate(() => (window as unknown as { calls: string[] }).calls.slice());
    await page.getByRole("button", { name: "Hide preview", exact: true }).click();
    expect(await apply.isVisible()).toBe(false);
    await page.getByRole("button", { name: "Show preview", exact: true }).click();
    expect(await page.getByRole("checkbox").isChecked()).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual(callsBeforeCollapse);
    await compatibility.check();
    await apply.waitFor({ state: "detached" });
    await preview.click();
    await apply.waitFor();
    expect(await apply.isDisabled()).toBe(true);
    await page.getByRole("checkbox").check();
    await page.evaluate(() => { (window as unknown as { failApply: boolean }).failApply = true; });
    await apply.click();
    await page.getByRole("alert").waitFor();
    await apply.waitFor({ state: "detached" });
    await page.evaluate(() => { (window as unknown as { failApply: boolean }).failApply = false; });
    await preview.click();
    await page.getByRole("checkbox").check();
    await apply.click();
    await page.getByRole("status").filter({ hasText: "Repair applied" }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([
      "preview:native", "preview:compatibility-v1", `apply:compatibility-v1:${"a".repeat(64)}`,
      "preview:compatibility-v1", `apply:compatibility-v1:${"a".repeat(64)}`, "repaired",
    ]);
    await page.evaluate(() => { (window as unknown as { preview: { status: string } }).preview.status = "blocked"; });
    await preview.click();
    await page.getByRole("status").filter({ hasText: "This preview cannot be applied" }).waitFor();
    expect(await apply.isDisabled()).toBe(true);
    expect(await page.getByRole("checkbox").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30_000);
