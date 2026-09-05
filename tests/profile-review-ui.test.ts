import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { resolveIntegrationTarget } from "../src/codex-integration-target";
import { installCodexIntegration } from "../src/codex-integration";
import { previewSetupConfiguration } from "../src/setup";
import { profileNativeCatalogFixture, unitProfileCapabilityFixture } from "./fixtures/profile-integration";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("target selector and two-target migration review wrap long paths and preserve initial/cancel focus", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-review-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const base = resolveIntegrationTarget({ codexHome: join(root, "long-codex-home-for-rendered-target-and-migration-evidence"), runtimeRoot: join(root, "runtime") });
    mkdirSync(base.codexHome);
    const baseConfig = { ...defaultConfig("browser-only", base.runtimeHome), integrationTarget: base };
    saveConfig(baseConfig);
    installCodexIntegration(baseConfig);
    const selected = resolveIntegrationTarget({ codexHome: base.codexHome, runtimeRoot: base.runtimeHome, profile: "native-profile-with-a-long-and-readable-name" });
    unitProfileCapabilityFixture(selected, root);
    writeFileSync(join(base.codexHome, "models_cache.json"), profileNativeCatalogFixture);
    const preview = previewSetupConfiguration({ target: selected, mode: "browser-only", port: 18942, migrateBase: true, browserHostDescriptorPath: join(root, "browser.json"), acknowledgedUnofficial: true, subagentProtocol: "native" });
    expect(preview.status).toBe("ready");
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/profile-review.tsx", "--target", "browser", "--outdir", join(root, "bundle")], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.evaluate(fixture => { (window as unknown as { profileFixture: unknown }).profileFixture = fixture; }, { preview, targets: { selected, targets: [base, selected], launchCommand: `CODEX_HOME='${base.codexHome}' '/verified/codex' --profile '${selected.profile}'` } });
    await page.addStyleTag({ content: readFileSync(join(root, "bundle", "profile-review.css"), "utf8") });
    await page.addScriptTag({ content: readFileSync(join(root, "bundle", "profile-review.js"), "utf8") });
    await page.getByRole("heading", { name: "Integration targets", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByText("Review base-to-profile migration", { exact: true }).first().click();
    const opener = page.getByRole("button", { name: "Review base-to-profile migration", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H2");
    expect(await dialog.locator(".configuration-target").count()).toBe(2);
    for (const width of [390, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (process.env.CHATGPT_TEST_PROFILE_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_PROFILE_SCREENSHOT });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent === "Review base-to-profile migration");
    expect(await opener.evaluate(element => element === document.activeElement)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
