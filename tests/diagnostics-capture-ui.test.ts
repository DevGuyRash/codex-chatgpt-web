import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { isPrivateCaptureSurface } from "../src/diagnostics/browser-capture";

test("rendered capture gate excludes credential controls even when their input type is generic", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    // Synthetic origin fixture only: every request is fulfilled locally; no ChatGPT session is used.
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<textarea id="prompt-textarea"></textarea>' }));
    await page.goto("https://chatgpt.com/c/fixture");
    expect(await isPrivateCaptureSurface(page)).toBe(true);
    for (const control of ['<input autocomplete="username">', '<input type="password">', '<input autocomplete="one-time-code">', '<div role="dialog">Authentication</div>']) {
      await page.setContent(`<textarea id="prompt-textarea"></textarea>${control}`);
      expect(await isPrivateCaptureSurface(page)).toBe(false);
    }
  } finally { await browser.close(); }
});
