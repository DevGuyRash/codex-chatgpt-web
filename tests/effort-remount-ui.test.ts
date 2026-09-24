import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-session";

for (const { missing, remountAt } of [
  { missing: false, remountAt: "effort-menu-open-requested" },
  { missing: false, remountAt: "effort-slider-visible" },
  { missing: true, remountAt: "effort-slider-visible" },
]) test.skipIf(!process.env.CHATGPT_TEST_CHROME_EXECUTABLE)(`effort selection reacquires a remounted picker or fails closed (at=${remountAt}, missing=${missing})`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300);
    await page.route("**/*", route => route.abort());
    await page.setContent(`
      <main><form><div id="prompt-textarea" contenteditable="true">Synthetic composer</div>
      <button type="button" aria-haspopup="menu" aria-expanded="false" data-tone="neutral" aria-controls="effort-menu">Effort</button></form></main>
      <div id="effort-menu" role="menu" hidden><div role="menuitem" tabindex="0"><div data-model-reasoning-effort-slider>
      <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span>Effort range</div></div></div>
      <script>
      window.openings = 0; window.steps = [];
      document.addEventListener('click', event => {
        if (!event.target.matches('button')) return;
        event.target.setAttribute('aria-expanded', 'true');
        window.openings++; document.querySelector('#effort-menu').hidden = false;
        if (window.failReopen) document.querySelector('[role="slider"]').remove();
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') { document.querySelector('button').setAttribute('aria-expanded', 'false'); document.querySelector('#effort-menu').hidden = true; return; }
        if (!event.target.matches('[role="menuitem"]') || !['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
        const slider = document.querySelector('[role="slider"]');
        const value = Number(slider.getAttribute('aria-valuenow')) + (event.key === 'ArrowRight' ? 1 : -1);
        slider.setAttribute('aria-valuenow', String(value)); window.steps.push(value);
      });
      </script>
    `);
    const select = (ChatGptBrowserWorker.prototype as unknown as {
      selectModelAndEffort(page: Page, model: string, effort: string, capabilities: unknown, capture: (checkpoint: string) => Promise<void>): Promise<unknown>;
    }).selectModelAndEffort;
    let remounted = false;
    const selection = select.call({
      activeComposer: async () => page.locator(CHATGPT_COMPOSER_SELECTOR).last(),
      assertSelectedEffort: (ChatGptBrowserWorker.prototype as any).assertSelectedEffort,
    }, page,
      "gpt-5.6-sol", "high", { localToolsEnabled: false, solAvailable: true, proAvailable: true }, async checkpoint => {
        if (checkpoint !== remountAt || remounted) return;
        remounted = true;
        await page.evaluate(missing => {
          const form = document.querySelector("form")!;
          form.replaceWith(form.cloneNode(true));
          const menu = document.querySelector<HTMLElement>("#effort-menu")!;
          const replacement = menu.cloneNode(true) as HTMLElement;
          replacement.hidden = true;
          // Reopening must observe this new value, not replay a step from the old picker.
          replacement.querySelector('[role="slider"]')!.setAttribute("aria-valuenow", "1");
          menu.replaceWith(replacement);
          (window as unknown as { failReopen: boolean }).failReopen = missing;
        }, missing);
      });
    let failure: unknown;
    try { await selection; } catch (error) { failure = error; }
    if (missing) expect(failure).toMatchObject({ code: "model_control_unavailable", retryable: false });
    else expect(failure).toBeUndefined();
    expect(remounted).toBe(true);
    expect(await page.evaluate(() => ({ openings: (window as unknown as { openings: number }).openings, steps: (window as unknown as { steps: number[] }).steps })))
      .toEqual({ openings: missing ? 2 : 3, steps: missing ? [] : [2] });
  } finally { await browser.close(); }
}, 15_000);
