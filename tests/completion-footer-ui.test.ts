import { expect, test } from "bun:test";
import { chromium, type Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)("assistant completion recognizes a new accessible footer without accepting unrelated controls", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    const snapshot = (ChatGptBrowserWorker.prototype as unknown as {
      responseDomSnapshot(turn: Locator): Promise<{ responsePresent: boolean; visibleText: string; completionActionVisible: boolean }>;
    }).responseDomSnapshot;
    const observe = async (html: string) => {
      await page.setContent(`<main><div id="older"><button aria-label="Unrelated older action"></button></div><div id="assistant" data-message-author-role="assistant">${html}</div></main>`);
      return snapshot.call({}, page.locator("#assistant"));
    };
    const footer = '<button aria-label="Copier le message"></button><button aria-label="Évaluer la réponse"></button>';
    expect(await observe(`<div class="markdown">Completed answer</div>${footer}`)).toMatchObject({ responsePresent: true, visibleText: "Completed answer", completionActionVisible: true });
    expect((await observe(`<button aria-label="Earlier action"></button><div class="markdown">Unfinished answer</div><button aria-label="One footer action"></button>`)).completionActionVisible).toBe(false);
    expect((await observe(`<div data-streaming-response-status>Working</div><div class="markdown">Partial answer</div>${footer}`)).completionActionVisible).toBe(false);
    expect((await observe(`<div aria-busy="true"></div><div class="markdown">Partial answer</div>${footer}`)).completionActionVisible).toBe(false);
    expect((await observe(`<div class="markdown">Legacy answer</div><button data-testid="copy-turn-action-button"></button>`)).completionActionVisible).toBe(true);
  } finally { await browser.close(); }
}, 15_000);
