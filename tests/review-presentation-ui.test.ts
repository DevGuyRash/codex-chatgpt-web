import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withConfigurationReview } from "../src/codex-configuration-review";
import { resolveIntegrationTarget } from "../src/codex-integration-target";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("changes-first review and linked profiles remain readable and discoverable in every language", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-review-presentation-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const target = resolveIntegrationTarget({ codexHome: join(root, "codex"), runtimeRoot: join(root, "runtime") });
    const preview = withConfigurationReview({ version: 1, status: "ready", approvalId: "a".repeat(64), protocol: "native", changes: [{ path: "openai_base_url", current: null, proposed: "http://localhost:17841/v1", currentState: "commented_out" }], conflicts: [], codexRestartRequired: true, launcherRestartRequired: true }, target, '# openai_base_url="http://localhost:17841/v1"\n[hooks]\nPermissionRequest=[{hooks=[{command="external helper"}]}]\n');
    preview.textChanges = [{ path: target.configPath, startLine: 1, before: Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(""), after: Array.from({ length: 30 }, (_, i) => i === 1 || i === 28 ? `changed ${i}\n` : `line ${i}\n`).join("") }];
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/review-presentation.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    for (const language of ["en", "zh-CN", "ja"]) {
      const page = await browser.newPage({ viewport: { width: 850, height: 1000 } });
      page.setDefaultTimeout(5_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.evaluate(fixture => { (window as unknown as { fixture: unknown }).fixture = fixture; }, { preview, language, targets: { selected: target, targets: [target], discovery: { entries: [{ ...target, id: "linked", kind: "profile", profile: "chatgpt-web", status: "external", resolvedPath: "/managed/linked.toml" }, { ...target, id: "broken", kind: "profile", profile: "broken", status: "unavailable" }], issues: [] } } });
      await page.addStyleTag({ content: readFileSync(join(root, "review-presentation.css"), "utf8") });
      await page.addScriptTag({ content: readFileSync(join(root, "review-presentation.js"), "utf8") });
      await page.locator(".configuration-change-card").waitFor();
      expect(await page.locator(".configuration-change-card").count()).toBe(1);
      const addedColor = await page.locator(".configuration-after").evaluate(element => getComputedStyle(element).backgroundColor);
      expect(addedColor).not.toBe("rgba(0, 0, 0, 0)");
      await page.getByRole("button", { name: language === "en" ? /Show unchanged settings/ : language === "ja" ? /変更のない設定を表示/ : /显示未更改的设置/ }).click();
      expect(await page.locator(".change-unchanged").count()).toBeGreaterThan(0);
      expect(await page.locator(".change-unchanged .configuration-value-pair").count()).toBe(0);
      expect(await page.locator(".change-unchanged .configuration-unchanged-value").count()).toBe(await page.locator(".change-unchanged").count());
      await page.locator(".configuration-text-change > summary").click();
      expect(await page.locator(".diff-removed").count()).toBe(2);
      expect(await page.locator(".diff-added").count()).toBe(2);
      const gap = page.locator(".configuration-diff > details");
      expect(await gap.count()).toBe(1);
      await gap.locator("summary").click();
      expect(await gap.getByText("line 15", { exact: true }).count()).toBe(2);
      await page.getByText(language === "en" ? "Advanced: separate command-line profiles" : language === "ja" ? "詳細設定：独立した CLI プロファイル" : "高级：独立的命令行配置档", { exact: true }).click();
      const external = page.locator("summary").filter({ hasText: "chatgpt-web ·" });
      await external.click();
      expect(await page.getByText("/managed/linked.toml", { exact: true }).isVisible()).toBe(true);
      expect(await page.locator("select option").count()).toBe(1);
      expect(await page.locator('input[maxlength="64"]').inputValue()).toBe("chatgpt-web-2");
      for (const width of [360, 850]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
      if (language === "en" && process.env.CHATGPT_TEST_PRESENTATION_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_PRESENTATION_SCREENSHOT, fullPage: true });
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
