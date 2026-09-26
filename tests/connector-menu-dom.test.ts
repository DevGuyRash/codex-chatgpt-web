import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { chatGptConnectorMenu } from "../src/adapters/chatgpt-web/connector-menu";
import { ChatGptBrowserWorker, resolveChatGptToolConfirmation, visibleChatGptAlertSummary } from "../src/adapters/chatgpt-web/browser-worker";

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
    await page.setContent(`
      <aside><button data-list-navigation-item="true">Codex Native2 DEV</button></aside>
      <div data-mention-list-scroll-area>
        <button data-list-navigation-item="true" hidden><span>Codex Native2 DEV</span></button>
        <button data-list-navigation-item="true" aria-current="true" data-fixture="modern"><span>Codex Native2 DEV</span><span>Connector description</span></button>
      </div>
    `);
    const modern = chatGptConnectorMenu(page, "Codex Native2 DEV");
    expect(await modern.exact.count()).toBe(1);
    expect(await modern.exact.getAttribute("data-fixture")).toBe("modern");
    expect(await modern.exact.getAttribute("aria-current")).toBe("true");
    await page.setContent('<div role="alert" id="approval">Allow ChatGPT to use Codex Native2 DEV?<button onclick="document.body.dataset.approved=\'once\';this.parentElement.remove()">Allow once</button><button>Always allow</button><button>Deny</button></div>');
    expect(await visibleChatGptAlertSummary(page)).toEqual({ count: 0, categories: [] });
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2 DEV", true)).toBe(true);
    expect(await page.locator('body').getAttribute('data-approved')).toBe('once');
    await page.setContent('<div role="alert">Unrelated ChatGPT notice</div>');
    expect(await resolveChatGptToolConfirmation(page, "Codex Native2 DEV", true)).toBe(false);
    await page.setContent('<div role="alert">Allow ChatGPT to use Codex Native2 DEV?<button onclick="document.body.dataset.approved=\'once\';this.parentElement.remove();document.body.insertAdjacentHTML(\'beforeend\',\'<div data-testid=&quot;conversation-turn-assistant&quot;></div>\')">Allow once</button><button>Always allow</button></div>');
    const worker = ChatGptBrowserWorker.forProvider({ adapter: "chatgpt-web", baseUrl: "https://chatgpt.com", chatgptWeb: { appName: "Codex Native2 DEV", autoApproveToolCalls: true } }) as unknown as {
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: undefined, signal: undefined, progress: undefined, graceMs: number, tracker: undefined, recovery: undefined, disconnected: undefined, handleToolConfirmation: boolean): Promise<{ identity: string }>;
      submissionDomState(page: Page): Promise<unknown>;
    };
    worker.submissionDomState = async () => ({
      userIdentities: [],
      responseIdentities: await page.locator('[data-testid="conversation-turn-assistant"]').count() ? ["conversation-turn-assistant"] : [],
      visibleStopButtonCount: 0,
    });
    const bound = await worker.waitForNewAssistantTurn(page, { initialResponseTurnIdentities: [], domCache: {} }, undefined, undefined, undefined, 1_000, undefined, undefined, undefined, true);
    expect(bound.identity).toBe("conversation-turn-assistant");
    expect(await page.locator('body').getAttribute('data-approved')).toBe('once');
  } finally { await browser.close(); }
}, 15_000);
