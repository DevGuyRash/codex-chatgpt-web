import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Real renderer/controller and Chromium; restart, recovery, and browser generation are substituted.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("selected action details preserve evidence and attribution outside Restart Options", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-action-feedback-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>', { headers: { "content-type": "text/html" } }) });
  try {
    const built = Bun.spawnSync([process.execPath, "build", "tests/fixtures/action-feedback.tsx", "--target", "browser", "--outdir", root], { cwd: resolve("launcher") });
    expect(built.exitCode).toBe(0);
    for (const language of ["en", "zh-CN", "ja"] as const) {
      const page = await browser.newPage({ viewport: { width: 360, height: 900 }, locale: language, reducedMotion: "reduce" });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(`http://127.0.0.1:${server.port}`);
        await page.evaluate(value => { Object.assign(window, { language: value }); }, language);
        await page.addStyleTag({ content: readFileSync(join(root, "action-feedback.css"), "utf8") });
        await page.addScriptTag({ content: readFileSync(join(root, "action-feedback.js"), "utf8") });
        const details = language === "en" ? "Details" : language === "ja" ? "詳細" : "详情";
        const history = language === "en" ? "History" : language === "ja" ? "履歴" : "历史";
        const feedback = page.getByRole("region", { name: language === "en" ? "Action feedback" : language === "ja" ? "操作結果" : "操作结果" });
        const open = page.getByRole("button", { name: language === "en" ? "Restart options" : language === "ja" ? "再起動のオプション" : "重启选项", exact: true });
        await open.waitFor();
        const placement = await open.evaluate(element => {
          const text = element.closest(".notice-row")!.querySelector(":scope > span")!;
          return { nestedInText: text.contains(element), textBottom: text.getBoundingClientRect().bottom, buttonTop: element.getBoundingClientRect().top };
        });
        expect(placement.nestedInText).toBe(false);
        expect(placement.buttonTop).toBeGreaterThanOrEqual(placement.textBottom);
        await open.click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("checkbox").waitFor();
        if (language === "en") await page.screenshot({ path: resolve("context/restart-options-preview.png"), fullPage: true });
        await page.evaluate(() => (window as unknown as { fail(): void }).fail());
        expect(await dialog.getByText("Review Codex configuration").count()).toBe(0);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        expect(await open.evaluate(element => document.activeElement === element)).toBe(true);
        expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([]);
        await feedback.getByRole("button", { name: details, exact: true }).click();
        await feedback.getByText("Managed realtime URL missing", { exact: true }).waitFor();
        await feedback.getByText("Interrupt hook differs", { exact: true }).waitFor();
        await feedback.getByText("Synthetic related evidence", { exact: true }).waitFor();
        if (language === "en") await page.screenshot({ path: resolve("context/startup-details-preview.png"), fullPage: true });
        const before = (await feedback.locator(".launcher-action-details").innerText());
        await page.evaluate(() => (window as unknown as { succeed(): void }).succeed());
        await feedback.getByRole("button", { name: `${history} (2)`, exact: true }).waitFor();
        expect(await feedback.getByText("Managed realtime URL missing", { exact: true }).isVisible()).toBe(true);
        expect(await feedback.locator(".launcher-action-details").innerText()).toBe(before);
        const cards = await feedback.locator(".launcher-action-latest").evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }));
        expect(cards.length).toBeLessThanOrEqual(3);
        for (let index = 1; index < cards.length; index++) expect(cards[index].top).toBeGreaterThanOrEqual(cards[index - 1].bottom);
        const diagnosticButton = feedback.getByRole("button", { name: language === "en" ? "Open Diagnostics" : language === "ja" ? "診断を開く" : "打开诊断", exact: true });
        await diagnosticButton.click();
        expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([`diagnostics:${"a".repeat(32)}`]);
        await page.keyboard.press("Escape");
        expect(await feedback.getByRole("button", { name: `${history} (2)`, exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
        await feedback.getByRole("button", { name: `${history} (2)`, exact: true }).click();
        await feedback.locator(".launcher-action-history").getByRole("button", { name: details, exact: true }).click();
        await feedback.getByText("Managed realtime URL missing", { exact: true }).waitFor();
        for (const width of [320, 640]) {
          await page.setViewportSize({ width, height: 900 });
          await diagnosticButton.scrollIntoViewIfNeeded();
          const bounds = (await diagnosticButton.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await page.keyboard.press("Escape");
        await feedback.locator(".launcher-action-details").waitFor({ state: "detached" });
        await page.evaluate(() => (window as unknown as { clear(): void; succeed(): void }).clear());
        await page.evaluate(() => (window as unknown as { succeed(): void }).succeed());
        await feedback.getByRole("status").first().waitFor();
        expect(await feedback.getByRole("button", { name: details, exact: true }).count()).toBe(0);
        await page.evaluate(() => (window as unknown as { smoke(): Promise<unknown> }).smoke());
        await feedback.getByRole("button", { name: details, exact: true }).click();
        await feedback.getByText(language === "en" ? "Received 22 response characters. Response content is not included in diagnostics." : language === "ja" ? "22 文字の応答を受信しました。応答内容は診断に含まれません。" : "收到 22 个响应字符。诊断不包含响应内容。", { exact: true }).waitFor();
        expect(await feedback.innerText()).not.toContain("PRIVATE_MODEL_RESPONSE");
        const doctorOpen = page.getByRole("button", { name: "Open Doctor", exact: true });
        await doctorOpen.click();
        await dialog.getByText("Doctor could not inspect the fixture", { exact: true }).waitFor();
        await page.evaluate(() => (window as unknown as { fail(): void }).fail());
        expect(await dialog.getByText("Managed realtime URL missing", { exact: true }).count()).toBe(0);
        await dialog.getByRole("button", { name: details, exact: true }).click();
        await dialog.getByText("Doctor-specific evidence", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        expect(await dialog.isVisible()).toBe(true);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        expect(await doctorOpen.evaluate(element => element === document.activeElement)).toBe(true);
        const reasons = {
          en: { busy: "Known bridge work is still active. Finish it before requesting a restart.", ambiguous: "More than one application matches Codex; choose the intended application manually.", unsupported: "Automatic restart is not supported for this environment." },
          "zh-CN": { busy: "桥接任务仍在运行。请完成后再请求重启。", ambiguous: "多个应用与 Codex 匹配；请手动选择目标应用。", unsupported: "此环境不支持自动重启。" },
          ja: { busy: "ブリッジの処理が実行中です。完了してから再起動を要求してください。", ambiguous: "Codex に一致するアプリが複数あります。対象を手動で選択してください。", unsupported: "この環境では自動再起動に対応していません。" },
        };
        for (const reason of ["busy", "ambiguous", "unsupported"] as const) {
          await page.evaluate(reason => { Object.assign(window, { availability: { status: "manual", reason } }); }, reason);
          await open.click();
          await dialog.getByText(reasons[language][reason], { exact: true }).waitFor();
          expect(await dialog.getByRole("button", { name: language === "en" ? "Restart Codex" : language === "ja" ? "Codex を再起動" : "重启 Codex", exact: true }).isDisabled()).toBe(true);
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
        }
        expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls.some(call => call.startsWith("restart:")))).toBe(false);
        if (language === "en") {
          await page.clock.install();
          await page.evaluate(() => (window as unknown as { clear(): void }).clear());
          await feedback.locator(".launcher-action-latest").waitFor({ state: "detached" });
          await page.evaluate(() => (window as unknown as { succeed(): void }).succeed());
          const success = feedback.locator('.launcher-action-latest[data-status="succeeded"]');
          await success.waitFor();
          await success.hover();
          await page.clock.runFor(6000);
          expect(await success.isVisible()).toBe(true);
          await page.mouse.move(0, 0);
          await page.clock.runFor(4000);
          expect(await success.isVisible()).toBe(true);
          await page.clock.runFor(1100);
          await success.waitFor({ state: "detached" });
          await feedback.getByRole("button", { name: "History (1)", exact: true }).click();
          expect(await feedback.locator(".launcher-action-history").isVisible()).toBe(true);
        }
        expect(errors).toEqual([]);
      } catch (error) {
        const screenshot = resolve(`context/action-feedback-${language}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        throw new Error(`${String(error)}\nSynthetic renderer: ${await page.locator("body").innerText()}\nErrors: ${JSON.stringify(errors)}\nScreenshot: ${screenshot}`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 45000);
