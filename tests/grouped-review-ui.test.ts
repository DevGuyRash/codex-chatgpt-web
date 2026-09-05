import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { previewSetupConfiguration, type SetupOptions } from "../src/setup";
import { resolveIntegrationTarget } from "../src/codex-integration-target";
import type { CodexRepairPreview, ConfigurationResolutionSelection } from "../src/contracts/codex-integration";

const require = createRequire(import.meta.url);
const { ConfigurationReview } = require("../launcher/electron/configuration-review.cjs");
const { registerLoggedIpc } = require("../launcher/electron/logging.cjs");

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("grouped review sends source choices through main/preload, preserves focus and invalidates approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-grouped-review-"));
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const target = resolveIntegrationTarget({ codexHome: join(root, "a-long-codex-home-for-layout-checks"), runtimeRoot: join(root, "runtime") });
    mkdirSync(target.codexHome);
    const original = 'openai_base_url="first"\nopenai_base_url="second" # retain this alternate\n';
    writeFileSync(target.configPath, original);
    let options: SetupOptions = { target, mode: "browser-only", browserHostDescriptorPath: join(root, "browser-descriptor.json"), subagentProtocol: "native", replaceCodexRoute: true, acknowledgedUnofficial: true };
    const bundle = Bun.spawnSync([process.execPath, "build", "tests/fixtures/grouped-review.tsx", "--target", "browser", "--outdir", join(root, "bundle")], { cwd: resolve("launcher") });
    expect(bundle.exitCode).toBe(0);
    const page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    let published: Promise<unknown> = Promise.resolve();
    const surfaceStates: boolean[] = [];
    const review = new ConfigurationReview({ publish(value: CodexRepairPreview | null) {
      if (value) surfaceStates.push(false);
      published = published.then(() => page.evaluate(preview => window.dispatchEvent(new CustomEvent("fixture-preview", { detail: preview })), value));
    } });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const main = readFileSync(resolve("launcher/electron/main.cjs"), "utf8");
    const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit("));
    runInNewContext(`${registration}\nregisterIpc({ logger: { error() {} }, stateStore: { update() { return {}; } } });`, {
      configurationReview: review, registerLoggedIpc, ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler), on() {} },
      browserHost: { setSurfaceActive: (value: boolean) => surfaceStates.push(value) },
    });
    let api: { decideConfiguration: (id: string, choice: unknown) => Promise<unknown> };
    runInNewContext(readFileSync(resolve("launcher/electron/preload.cjs"), "utf8"), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: typeof api) => { api = value; } },
        ipcRenderer: { invoke: (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args) } }),
    });
    let finishRefresh: (() => void) | undefined;
    let outcome = "";
    await page.exposeFunction("beginReview", () => {
      void review.request(previewSetupConfiguration(options), async (choice: { resolutions: ConfigurationResolutionSelection[] } | "native" | "compatibility-v1") => {
        options = typeof choice === "string" ? { ...options, subagentProtocol: choice } : { ...options, resolutions: choice.resolutions };
        await new Promise<void>(resolve => { finishRefresh = resolve; });
        return previewSetupConfiguration(options);
      }).then(() => { outcome = "approved"; }, () => { outcome = "cancelled"; });
    });
    await page.exposeFunction("fixtureDecide", (id: string, choice: unknown) => api.decideConfiguration(id, choice));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: 'window.codexWebLauncher={decideConfiguration:window.fixtureDecide,onConfigurationPreview(listener){const fn=e=>listener(e.detail);window.addEventListener("fixture-preview",fn);return()=>window.removeEventListener("fixture-preview",fn)}};' });
    await page.addStyleTag({ content: readFileSync(join(root, "bundle", "grouped-review.css"), "utf8") });
    await page.addScriptTag({ content: readFileSync(join(root, "bundle", "grouped-review.js"), "utf8") });
    const opener = page.getByRole("button", { name: "Review configuration", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Review setup changes");
    const identity = await dialog.elementHandle();
    expect(await dialog.getByRole("table").count()).toBe(0);
    expect(await dialog.getByRole("button", { name: "Use this definition", exact: true }).count()).toBe(2);
    await dialog.getByRole("button", { name: "Use this definition", exact: true }).first().click();
    await dialog.getByRole("status").filter({ hasText: "Updating comparison" }).waitFor();
    expect(review.snapshot().approvalId).toBe("");
    await handlers.get("launcher:browser-surface-active")!({}, true);
    expect(surfaceStates.at(-1)).toBe(false);
    expect(await identity!.evaluate(element => element.isConnected && (element as HTMLDialogElement).open)).toBe(true);
    expect(await dialog.getByRole("button", { name: "Cancel setup", exact: true }).isEnabled()).toBe(true);
    finishRefresh!();
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    expect(review.snapshot().status).toBe("ready");
    expect(review.snapshot().resolutions).toHaveLength(1);
    const primaryValues = await dialog.locator(".configuration-value-pair").allTextContents();
    expect(primaryValues.join(" ")).not.toContain("sha256:");
    expect(primaryValues.join(" ")).toContain("Approve the proposed cleanup definition");
    for (const width of [360, 760]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    if (process.env.CHATGPT_TEST_GROUPED_SCREENSHOT) await page.screenshot({ path: process.env.CHATGPT_TEST_GROUPED_SCREENSHOT });
    expect(readFileSync(target.configPath, "utf8")).toBe(original);
    await dialog.getByRole("checkbox").check();
    const native = dialog.getByRole("radio", { name: "Native (preserve newer feature choices)", exact: true });
    await native.focus();
    await page.keyboard.press("ArrowLeft");
    await dialog.getByRole("status").filter({ hasText: "Updating comparison" }).waitFor();
    expect(review.snapshot().protocol).toBe("compatibility-v1");
    expect(await dialog.getByRole("checkbox").isChecked()).toBe(false);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(outcome).toBe("cancelled");
    expect(await opener.evaluate(element => element === document.activeElement)).toBe(true);
    finishRefresh!();
    await published;
    expect(review.snapshot()).toBeNull();
    expect(errors).toEqual([]);
  } finally { await browser.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
