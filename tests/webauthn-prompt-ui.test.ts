import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("phone passkey Cancel reaches the owned request controller", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const context = window as typeof window & {
        codexPasskeyPrompt: unknown;
        cancelled: Array<{ id: string; action: string }>;
      };
      context.cancelled = [];
      context.codexPasskeyPrompt = {
        current: async () => ({ id: "11111111-1111-4111-8111-111111111111", kind: "qr", origin: "https://example.com", relyingPartyId: "example.com", phoneAvailable: true, securityKeyAvailable: true, bluetoothStatus: "on", extensionProviders: [] }),
        onState() {}, onWaiting() {},
        respond: async (answer: { id: string; action: string }) => { context.cancelled.push(answer); return true; },
      };
    });
    await page.goto(pathToFileURL(resolve("launcher/electron/webauthn-prompt.html")).href);
    await expect(page.locator("#title").innerText()).resolves.toBe("Use a phone passkey");
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.evaluate(() => (window as typeof window & { cancelled: unknown[] }).cancelled)).toEqual([
      { id: "11111111-1111-4111-8111-111111111111", action: "cancel" },
    ]);
  } finally { await browser.close(); }
});
