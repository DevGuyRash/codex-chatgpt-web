import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { chatGptConnectorMenu } from "../src/adapters/chatgpt-web/connector-menu";

// This is an offline selector contract, not an authenticated ChatGPT journey.
// Set CHATGPT_TEST_CHROME_EXECUTABLE to a real Chromium executable to run it.
test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("connector lookup excludes sidebar and hidden ghosts, preserving genuine ambiguity", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    await page.setContent(`
      <aside><a class="__menu-item" tabindex="0" data-sidebar-item="true"><span>Codex Native2</span></a></aside>
      <div data-composer-plugin-impression-id="random-ghost"><div class="__menu-item" tabindex="0" hidden><span>Codex Native2</span></div></div>
      <div data-composer-plugin-impression-id="random-live"><div class="__menu-item" tabindex="0" data-highlighted="" data-fixture="intended"><span>Codex Native2</span><span>Connector</span></div></div>
    `);
    const menu = chatGptConnectorMenu(page, "Codex Native2");
    expect(await menu.exact.count()).toBe(1);
    expect(await menu.exact.getAttribute("data-fixture")).toBe("intended");
    expect(await menu.exact.getAttribute("data-highlighted")).toBe("");
    await page.locator('[data-fixture="intended"]').evaluate(element => element.parentElement!.append(element.cloneNode(true)));
    expect(await menu.exact.count()).toBe(2);
    await expect(menu.exact.getAttribute("data-highlighted", { timeout: 500 })).rejects.toThrow("strict mode violation");
    await page.locator('[data-fixture="intended"]').evaluateAll(elements => elements.forEach(element => element.remove()));
    expect(await menu.exact.count()).toBe(0);
  } finally { await browser.close(); }
}, 15_000);
