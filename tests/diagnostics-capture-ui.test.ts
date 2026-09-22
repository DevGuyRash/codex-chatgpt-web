import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { isPrivateCaptureSurface, visibleConversationState, captureVisibleConversationImage, inspectCaptureSurface } from "../src/diagnostics/browser-capture";

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
