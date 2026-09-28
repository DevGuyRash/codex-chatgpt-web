import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright-core";
import { isPrivateCaptureSurface, visibleConversationState, captureVisibleConversationImage, captureVisibleConversationImageWithRetry, captureVisibleChatGptAlertImages, visibleChatGptAlertTexts, inspectCaptureSurface } from "../src/diagnostics/browser-capture";

test("a timed-out campaign screenshot retries only after the caller validates its unchanged surface", async () => {
  let screenshots = 0, validations = 0;
  const timeout = Object.assign(new Error("Synthetic renderer timeout"), { name: "TimeoutError" });
  const page = {
    locator: () => ({ evaluate: async () => ({ x: 0, y: 0, width: 100, height: 80 }) }),
    screenshot: async () => { if (++screenshots === 1) throw timeout; return Buffer.from("synthetic image"); },
  } as unknown as Page;
  expect(await captureVisibleConversationImageWithRetry(page, async () => { validations++; return true; })).toEqual(Buffer.from("synthetic image"));
  expect({ screenshots, validations }).toEqual({ screenshots: 2, validations: 1 });
  screenshots = 0;
  expect(await captureVisibleConversationImageWithRetry(page, async () => { validations++; return false; })).toBeNull();
  expect({ screenshots, validations }).toEqual({ screenshots: 1, validations: 2 });
  let repeated = 0;
  const stalledPage = { ...page, screenshot: async () => { repeated++; throw timeout; } } as unknown as Page;
  await expect(captureVisibleConversationImageWithRetry(stalledPage, async () => true)).rejects.toMatchObject({ name: "TimeoutError" });
  expect(repeated).toBe(2);
  let surfaceChecks = 0;
  const rejectedDirect = { ...stalledPage, context: () => { throw new Error("Direct capture must not start after surface rejection"); } } as unknown as Page;
  expect(await captureVisibleConversationImageWithRetry(rejectedDirect, async () => ++surfaceChecks === 1)).toBeNull();
  expect(surfaceChecks).toBe(2);
});

test("a twice-timed-out Playwright screenshot falls back to a clipped Chromium capture", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<main></main><textarea id="prompt-textarea"></textarea>' }));
    await page.goto("https://chatgpt.com/c/fixture");
    await page.setContent('<style>body{margin:0}aside{position:absolute;width:200px;height:600px;background:red}main{position:absolute;left:200px;width:600px;height:600px;background:blue}</style><aside>Unrelated sidebar</aside><main>Visible conversation</main><textarea id="prompt-textarea"></textarea>');
    let screenshots = 0, validations = 0, fallbacks = 0;
    const screenshot = page.screenshot;
    page.screenshot = async () => { screenshots++; throw Object.assign(new Error("Synthetic renderer timeout"), { name: "TimeoutError" }); };
    try {
      const image = await captureVisibleConversationImageWithRetry(page, async next => {
        validations++;
        if (next === "direct") fallbacks++;
        return (await inspectCaptureSurface(page)).allowed;
      });
      expect(image?.readUInt32BE(16)).toBe(600);
      expect(image?.readUInt32BE(20)).toBe(600);
      expect({ screenshots, validations, fallbacks }).toEqual({ screenshots: 2, validations: 2, fallbacks: 1 });
    } finally { page.screenshot = screenshot; }
  } finally { await browser.close(); }
});
import { visibleChatGptAlertSummary } from "../src/adapters/chatgpt-web/browser-worker";

test("rendered capture gate excludes credential controls even when their input type is generic", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    // Synthetic origin fixture only: every request is fulfilled locally; no ChatGPT session is used.
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<textarea id="prompt-textarea"></textarea>' }));
    await page.goto("https://chatgpt.com/c/fixture");
    expect(await isPrivateCaptureSurface(page)).toBe(true);
    await page.setContent('<main><textarea id="prompt-textarea"></textarea><iframe style="display:none" srcdoc="Synthetic embedded frame"></iframe></main>');
    expect(await isPrivateCaptureSurface(page)).toBe(true);
    await page.locator('iframe').evaluate(element => { (element as HTMLElement).style.display = 'block'; });
    expect(await inspectCaptureSurface(page)).toMatchObject({ allowed: false, reason: "visible-embedded-frame" });
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div><input type="file" multiple><input type="file" accept="image/*"></main>');
    expect(await isPrivateCaptureSurface(page)).toBe(true);
    await page.setContent('<main><div data-turn-key="fixture-turn"><div data-user-message-bubble>Modern user request</div><div data-content-search-unit-key="fixture:assistant"><h4 data-conversation-role="assistant">Assistant</h4><div data-markdown-text-style="assistant-message">Modern answer</div></div></div><div data-turn-key="hidden-turn" hidden><div data-user-message-bubble>hidden user secret</div></div><form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox"></div><input type="file"></form></main>');
    expect(await inspectCaptureSurface(page)).toMatchObject({ allowed: true, reason: "conversation" });
    const modern = JSON.parse(await visibleConversationState(page));
    expect(modern.map((entry: { role: string }) => entry.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(modern)).toContain("Modern answer");
    expect(JSON.stringify(modern)).not.toContain("hidden user secret");
    await page.setContent('<aside>unrelated conversation</aside><main><div data-message-author-role="assistant" data-secret="attribute secret"><p>Visible result: 42</p><pre><code>retained code</code></pre><span hidden>hidden secret</span><span style="display:none">invisible secret</span><script type="application/json">{"token":"script secret"}</script><input value="input secret"></div><nav>unrelated navigation</nav></main><textarea id="prompt-textarea"></textarea>');
    const state = await visibleConversationState(page);
    expect(state).toContain("Visible result: 42");
    expect(state).toContain("retained code");
    expect(state).not.toContain("secret");
    expect(state).not.toContain("unrelated");
    for (const hidden of ['style="display:none"', 'aria-hidden="true"', 'hidden']) {
      await page.setContent(`<main><section ${hidden}><div data-message-author-role="assistant">unrelated hidden ancestor</div></section><div data-message-author-role="assistant">visible current result</div></main><textarea id="prompt-textarea"></textarea>`);
      const content = await visibleConversationState(page);
      expect(content).not.toContain("unrelated");
      expect(content).toContain("visible current result");
    }
    for (const control of ['<input autocomplete="username">', '<input type="password">', '<input autocomplete="one-time-code">', '<div role="dialog">Authentication</div>']) {
      await page.setContent(`<textarea id="prompt-textarea"></textarea><input type="file">${control}`);
      expect(await isPrivateCaptureSurface(page)).toBe(false);
    }
    await page.setContent('<textarea id="prompt-textarea"></textarea><div role="dialog">Private dialog content</div><input type="password" value="private-value"><input type="range" value="7"><input value="private-username">');
    const blocked = await inspectCaptureSurface(page);
    expect(blocked).toMatchObject({ allowed: false, reason: "visible-sensitive-control" });
    expect(blocked.blockedKinds?.sort()).toEqual(["dialog", "other-input", "password-input", "text-input"]);
    expect(JSON.stringify(blocked)).not.toContain("private");
  } finally { await browser.close(); }
});

test("conversation capture uses its visible viewport without waiting for animated layout stability", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<style>body{margin:0}aside{position:absolute;width:200px;height:600px;background:red}main{position:absolute;left:200px;width:600px;height:1200px;background:blue}</style><aside>Unrelated sidebar</aside><main><p>Synthetic conversation</p></main>');
    await page.evaluate(() => { const main = document.querySelector('main') as HTMLElement; let frame = 0; const move = () => { main.style.height = `${1200 + ++frame % 2}px`; requestAnimationFrame(move); }; move(); });
    const screenshot = await captureVisibleConversationImage(page);
    // PNG IHDR dimensions prove cropping excluded the sidebar and offscreen content.
    expect(screenshot.readUInt32BE(16)).toBe(600);
    expect(screenshot.readUInt32BE(20)).toBe(600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally { await browser.close(); }
});

test("retained conversation capture includes visible messages overflowing an offscreen main box", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<style>body{margin:0}aside{position:absolute;width:200px;height:600px;background:red}main{position:absolute;left:200px;top:-1200px;width:600px;height:600px}main [data-message-author-role]{position:absolute;top:1500px;width:600px;height:250px;background:blue}</style><aside>Unrelated sidebar</aside><main><div data-message-author-role="assistant">Visible retained result</div></main>');
    const screenshot = await captureVisibleConversationImage(page);
    expect(screenshot.readUInt32BE(16)).toBe(600);
    expect(screenshot.readUInt32BE(20)).toBe(250);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await page.locator('[data-message-author-role]').evaluate(element => element.remove());
    await expect(captureVisibleConversationImage(page)).rejects.toThrow("outside the visible viewport");
  } finally { await browser.close(); }
});

test("conversation evidence capture does not complete the application's pending animations", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<main style="width:600px;height:400px"><p>Completed synthetic response</p><textarea id="prompt-textarea"></textarea></main>');
    await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const animation = main.animate([{ opacity: 1 }, { opacity: 0.9 }], { duration: 60_000, fill: "forwards" });
      animation.onfinish = () => { main.setAttribute("data-animation-finished", "true"); document.querySelector("textarea")?.remove(); };
    });
    await captureVisibleConversationImage(page);
    expect(await page.locator("main").getAttribute("data-animation-finished")).toBeNull();
    expect(await page.locator("#prompt-textarea").count()).toBe(1);
  } finally { await browser.close(); }
});

test("failed-turn alert capture clips only visible alert regions without scrolling", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_TEST_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<style>body{margin:0}aside{position:absolute;left:0;top:0;width:200px;height:600px;background:red}.alert{position:absolute;left:600px;top:20px;width:180px;height:80px;background:blue}</style><aside>Unrelated sidebar</aside><main><div role="alert" class="alert">Synthetic ChatGPT failure</div><div role="alert" hidden>Hidden alert</div><div role="alert"><input value="credential content"></div></main>');
    const images = await captureVisibleChatGptAlertImages(page);
    expect(images).toHaveLength(1);
    expect(images[0]!.readUInt32BE(16)).toBe(180);
    expect(images[0]!.readUInt32BE(20)).toBe(80);
    expect(await page.evaluate(() => scrollY)).toBe(0);
    expect(await visibleChatGptAlertSummary(page)).toEqual({ count: 1, categories: ["service"] });
    expect(await visibleChatGptAlertTexts(page)).toEqual(["Synthetic ChatGPT failure"]);
    await page.locator('.alert').evaluate(element => { element.textContent = 'Too many requests'; });
    expect(await visibleChatGptAlertSummary(page)).toEqual({ count: 1, categories: ["frequency"] });
    await page.locator('main').evaluate(element => { element.insertAdjacentHTML('beforeend', '<div role="alert" style="position:absolute;left:300px;top:20px;width:180px;height:80px">Enter your YubiKey PIN</div>'); });
    expect(await captureVisibleChatGptAlertImages(page)).toHaveLength(1);
    expect(await visibleChatGptAlertTexts(page)).toEqual(["Too many requests"]);
    await page.locator('.alert').evaluate(element => { element.textContent = 'Something went wrong for user@example.com ref abcdefghijklmnopqrstuvwxyz'; });
    const redacted = await visibleChatGptAlertTexts(page);
    expect(redacted).toHaveLength(1);
    expect(redacted[0]).toContain("[redacted email]");
    expect(redacted[0]).toContain("[redacted value]");
    expect(redacted[0]).not.toContain("user@example.com");
  } finally { await browser.close(); }
});
