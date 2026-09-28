import type { Page } from "playwright-core";
import { CHATGPT_COMPOSER_SELECTOR } from "../chatgpt-session";
import { runtimeCaptureClient, runtimeDiagnostics } from "./runtime";
import { campaignCaptureId, captureCampaignContent, omitCampaignCapture } from "./campaign-capture";

type CaptureBlockedControl = "dialog" | "text-input" | "password-input" | "other-input" | "textarea" | "iframe";

/** Fail closed on login, settings, visible embedded frames, and modal/credential surfaces. No DOM is retained. */
export async function isPrivateCaptureSurface(page: Page): Promise<boolean> {
  return (await inspectCaptureSurface(page)).allowed;
}

/** Only fixed reason codes cross the boundary; never retain field values or frame URLs. */
export async function inspectCaptureSurface(page: Page): Promise<{ allowed: boolean; reason: string; blockedKinds?: CaptureBlockedControl[] }> {
  try {
    const url = new URL(page.url());
    if (url.origin !== "https://chatgpt.com" || !/^\/(?:c\/[a-zA-Z0-9-]+)?\/?$/.test(url.pathname)) return { allowed: false, reason: "unrecognized-url" };
    // Hidden third-party frames appear during normal conversation use. Inspect only their
    // embedding element's visibility, never frame content, URLs or authentication state.
    for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
      const element = await frame.frameElement();
      try { if (await element.isVisible()) return { allowed: false, reason: "visible-embedded-frame", blockedKinds: ["iframe"] }; }
      finally { await element.dispose(); }
    }
    return await page.evaluate((composerSelector) => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      // Generic text controls can also be username/credential fields. Extra visible inputs fail closed.
      // Upload inputs cannot accept credential text; their values are excluded from retained DOM.
      const blocked = document.querySelectorAll('input:not([type="file"]),[role="dialog"],dialog[open],iframe,textarea:not(#prompt-textarea)');
      const blockedKinds = [...new Set([...blocked].filter(visible).map((element): CaptureBlockedControl => {
        if (element.matches('[role="dialog"],dialog[open]')) return "dialog";
        if (element.tagName === "IFRAME") return "iframe";
        if (element.tagName === "TEXTAREA") return "textarea";
        const type = (element as HTMLInputElement).type;
        if (type === "password") return "password-input";
        return ["text", "email", "tel", "url", "search", "number"].includes(type) ? "text-input" : "other-input";
      }))];
      if (blockedKinds.length) return { allowed: false, reason: "visible-sensitive-control", blockedKinds };
      const allowed = [...document.querySelectorAll(composerSelector)].some(visible);
      return { allowed, reason: allowed ? "conversation" : "composer-unavailable" };
    }, CHATGPT_COMPOSER_SELECTOR);
  } catch { return { allowed: false, reason: "inspection-failed" }; }
}

type ConversationClip = { x: number; y: number; width: number; height: number };

/** Capture only the current viewport intersection; never include the sidebar. */
async function visibleConversationClip(page: Page): Promise<ConversationClip> {
  const clip = await page.locator("main").evaluate((main, composerSelector) => {
    const regions = [main, ...main.querySelectorAll(`[data-message-author-role="user"],[data-message-author-role="assistant"],[data-message-author-role="tool"],[data-turn-key] [data-user-message-bubble],[data-turn-key] [data-markdown-text-style="assistant-message"],${composerSelector}`)].flatMap(element => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return [];
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      return right > left && bottom > top ? [{ left, top, right, bottom }] : [];
    });
    // Retained conversations can overflow a main box that has scrolled offscreen.
    // Its visible message/composer descendants still belong to this conversation.
    if (!regions.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...regions.map(rect => rect.left)), y = Math.min(...regions.map(rect => rect.top));
    return { x, y, width: Math.max(...regions.map(rect => rect.right)) - x, height: Math.max(...regions.map(rect => rect.bottom)) - y };
  }, CHATGPT_COMPOSER_SELECTOR, { timeout: 3000 });
  if (!Object.values(clip).every(Number.isFinite) || clip.width <= 0 || clip.height <= 0) throw new Error("Conversation is outside the visible viewport");
  return clip;
}

/** Capture the current viewport intersection without scrolling or waiting for layout stability. */
export async function captureVisibleConversationImage(page: Page): Promise<Buffer> {
  const clip = await visibleConversationClip(page);
  // Disabling animations fast-forwards finite animations and dispatches their finish handlers.
  // Evidence collection must observe the app, not trigger its pending UI transitions.
  return await page.screenshot({ clip, animations: "allow", caret: "hide", timeout: 3000, type: "png" });
}

/** A direct Chromium capture bypasses Playwright's font/animation preparation after its bounded retries. */
async function captureVisibleConversationImageViaCdp(page: Page): Promise<Buffer> {
  const clip = await visibleConversationClip(page);
  const session = await page.context().newCDPSession(page);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { ...clip, scale: 1 } }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error("Direct conversation capture timed out"), { name: "TimeoutError" })), 5000);
      }),
    ]);
    return Buffer.from(response.data, "base64");
  } finally {
    if (timeout) clearTimeout(timeout);
    // Try to release an outstanding CDP command without letting cleanup stall the native turn.
    let detachTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.detach().catch(() => {}),
        new Promise<void>(resolve => { detachTimeout = setTimeout(resolve, 1000); }),
      ]);
    } finally { if (detachTimeout) clearTimeout(detachTimeout); }
  }
}

/** Retry transient Chromium timeouts only after privacy and URL ownership are revalidated. */
export async function captureVisibleConversationImageWithRetry(page: Page, revalidate: (next: "retry" | "direct") => Promise<boolean>): Promise<Buffer | null> {
  try { return await captureVisibleConversationImage(page); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    if (!await revalidate("retry")) return null;
    try { return await captureVisibleConversationImage(page); }
    catch (retryError) {
      if (!(retryError instanceof Error) || retryError.name !== "TimeoutError") throw retryError;
      if (!await revalidate("direct")) return null;
      if (typeof page.context !== "function") throw retryError;
      return await captureVisibleConversationImageViaCdp(page);
    }
  }
}

/** Capture only visible alert rectangles after a failed owned turn; never scroll or include the sidebar. */
export async function captureVisibleChatGptAlertImages(page: Page): Promise<Buffer[]> {
  const regions = await page.locator('[role="alert"]').evaluateAll(elements => elements.flatMap(element => {
    const candidate = element as HTMLElement;
    const style = getComputedStyle(candidate);
    const text = (candidate.innerText ?? candidate.textContent ?? "").trim();
    if (style.display === "none" || style.visibility === "hidden"
      || !text || /passkey|security key|yubikey|\bpin\b|password|sign[ -]?in|log[ -]?in|session.{0,40}expir|authenticat|verification|\b2fa\b|qr code/i.test(text)
      || candidate.querySelector("input,textarea,[contenteditable=true]")) return [];
    const rect = candidate.getBoundingClientRect();
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top || (right - left) * (bottom - top) > 400_000) return [];
    return [{ x: left, y: top, width: right - left, height: bottom - top }];
  }).slice(0, 3));
  const images: Buffer[] = [];
  for (const clip of regions) {
    images.push(await page.screenshot({ clip, animations: "allow", caret: "hide", timeout: 3000, type: "png" }));
  }
  return images;
}

/** Campaign-only alert text from a failed submitted turn; no auth notices or raw token-like values. */
export async function visibleChatGptAlertTexts(page: Page): Promise<string[]> {
  return page.locator('[role="alert"]').evaluateAll(elements => elements.flatMap(element => {
    const candidate = element as HTMLElement;
    const style = getComputedStyle(candidate);
    const text = (candidate.innerText ?? candidate.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || style.display === "none" || style.visibility === "hidden"
      || candidate.querySelector("input,textarea,[contenteditable=true]")
      || /passkey|security key|yubikey|\bpin\b|password|sign[ -]?in|log[ -]?in|session.{0,40}expir|authenticat|verification|\b2fa\b|qr code/i.test(text)) return [];
    if (text.length > 2_000) return ["[alert content omitted: too long]"];
    return [text.replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "[redacted context]")
      .replace(/https?:\/\/\S+/gi, "[redacted URL]")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
      .replace(/\b(?:[A-Za-z0-9_-]{24,}|\d{4,})\b/g, "[redacted value]")
      .slice(0, 500)];
  }).slice(0, 3));
}

/** Retain exposed conversation content, never raw app HTML, attributes, or hidden state. */
export async function visibleConversationState(page: Page): Promise<string> {
  return page.locator("main").evaluate(main => {
    const blocked = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "INPUT", "TEXTAREA", "SVG"]);
    const read = (element: Element): unknown => {
      const style = getComputedStyle(element);
      if (blocked.has(element.tagName) || element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return null;
      const children = [...element.childNodes].flatMap(node => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ? [node.textContent] : [];
        if (node instanceof Element) { const content = read(node); return content === null ? [] : [content]; }
        return [];
      });
      return children.length ? { tag: element.tagName.toLowerCase(), children } : null;
    };
    const exposed = (message: Element): boolean => {
      for (let ancestor: Element | null = message; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hasAttribute("hidden") || ancestor.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden") return false;
      }
      return true;
    };
    const legacy = [...main.querySelectorAll('[data-message-author-role]')].flatMap(message => {
      if (!exposed(message)) return [];
      const content = read(message), role = message.getAttribute("data-message-author-role");
      return content && ["user", "assistant", "tool"].includes(role ?? "") ? [{ role, content }] : [];
    });
    const grouped = [...main.querySelectorAll('[data-turn-key]')].flatMap(group => {
      if (!exposed(group)) return [];
      const user = group.querySelector('[data-user-message-bubble]');
      const assistantLabel = group.querySelector('[data-conversation-role="assistant"]');
      const assistant = assistantLabel?.closest('[data-content-search-unit-key]');
      const userContent = user && exposed(user) ? read(user) : null;
      const assistantContent = assistant && exposed(assistant) ? read(assistant) : null;
      return [
        ...(userContent ? [{ role: "user", content: userContent }] : []),
        ...(assistantContent ? [{ role: "assistant", content: assistantContent }] : []),
      ];
    });
    return JSON.stringify([...legacy, ...grouped]);
  }, { timeout: 3000 });
}

export async function captureBrowserCheckpoint(page: Page, checkpoint: string, failed: boolean, readiness: "conversation" | "preflight" = "conversation", afterSend = false): Promise<void> {
  const diagnostics = runtimeDiagnostics(); const context = diagnostics?.context();
  diagnostics?.event("browser.checkpoint", "Browser stage checkpoint", { checkpoint, failed }, failed ? "warning" : "debug");
  if (!diagnostics || !context) return;
  const client = runtimeCaptureClient();
  const campaign = campaignCaptureId();
  if (!client || !campaign && !client.privateCaptureEnabled()) return;
  let collectionStage = "claim";
  try {
    if (!campaign && !await client.claimCapture(context.traceId)) return;
    collectionStage = "surface-inspection";
    const surface = await inspectCaptureSurface(page);
    if (!surface.allowed) {
      if (readiness === "preflight" && !failed) {
        diagnostics.event("capture.not_applicable", "Conversation capture is not applicable before authenticated conversation readiness", { checkpoint, reason: surface.reason }, "info"); return;
      }
      if (campaign) await omitCampaignCapture("surface-excluded", context);
      diagnostics.event("capture.excluded", "Private capture omitted on an authentication, modal, or unrecognized surface", { checkpoint, reason: surface.reason, ...(surface.blockedKinds ? { blockedKinds: surface.blockedKinds } : {}) }, "warning"); return;
    }
    const url = page.url();
    const validateCapturedSurface = async (stage: string): Promise<boolean> => {
      collectionStage = stage;
      const beforeUrl = page.url();
      const current = await inspectCaptureSurface(page);
      const navigationChanged = beforeUrl !== url || page.url() !== url;
      if (!navigationChanged && current.allowed) return true;
      if (campaign) await omitCampaignCapture("surface-excluded", context);
      diagnostics.event("capture.excluded", "Private capture discarded because the browser surface changed", {
        checkpoint, collectionStage, navigationChanged, reason: navigationChanged ? "navigation" : current.reason, ...(current.blockedKinds ? { blockedKinds: current.blockedKinds } : {}),
      }, "warning");
      return false;
    };
    if (campaign && failed && afterSend) {
      collectionStage = "alert-text";
      const alertTexts = await visibleChatGptAlertTexts(page);
      if (alertTexts.length) {
        if (!await validateCapturedSurface("alert-text-validation")) return;
        await captureCampaignContent("browser-state", JSON.stringify({ kind: "chatgpt-alerts", alerts: alertTexts }), context);
        diagnostics.event("capture.chatgpt_alert_text", "Visible ChatGPT alerts were retained only in private campaign evidence", { checkpoint, count: alertTexts.length }, "info", context);
      }
      collectionStage = "alert-screenshot";
      const alerts = await captureVisibleChatGptAlertImages(page);
      for (const [index, image] of alerts.entries()) {
        if (!await validateCapturedSurface("alert-validation")) return;
        await captureCampaignContent("screenshot", image.toString("base64"), context);
        diagnostics.event("capture.chatgpt_alert_image", "A visible ChatGPT alert was retained only in private campaign evidence", { checkpoint, index, total: alerts.length }, "info", context);
      }
    }
    collectionStage = "screenshot";
    const png = campaign ? await captureVisibleConversationImageWithRetry(page, async next => {
      if (!await validateCapturedSurface(next === "retry" ? "screenshot-retry-validation" : "screenshot-direct-validation")) return false;
      collectionStage = next === "retry" ? "screenshot-retry" : "screenshot-direct";
      diagnostics.event(next === "retry" ? "capture.retry" : "capture.fallback", next === "retry"
        ? "Conversation screenshot timed out once; retrying after surface validation"
        : "Conversation screenshot timed out twice; trying bounded direct Chromium capture after surface validation", { checkpoint, collectionStage }, "warning");
      return true;
    }) : await page.screenshot({ animations: "allow", caret: "hide", timeout: 3000, type: "png" });
    if (!png) return;
    if (!await validateCapturedSurface("screenshot-validation")) return;
    if (campaign) {
      collectionStage = "screenshot-storage";
      await captureCampaignContent("screenshot", png.toString("base64"), context);
      collectionStage = "conversation-state";
      const dom = await visibleConversationState(page);
      if (await validateCapturedSurface("conversation-validation")) await captureCampaignContent("browser-state", dom, context);
      return;
    }
    const result = await client.writeCapture(context.traceId, png);
    diagnostics.event("capture.result", result.status === "stored" ? "Private image stored separately; excluded from ordinary exports" : "Private image was not retained", { checkpoint, result: result.status, ...(result.status === "omitted" ? { reason: result.reason } : { expires: result.expires }) }, result.status === "stored" ? "info" : "warning");
  } catch (error) {
    if (campaign) await omitCampaignCapture("capture-failed", context);
    diagnostics.problem(error, "Browser capture was not retained", { stage: "browser.capture" }, context);
    diagnostics.event("capture.failed", "Private capture was not retained; collection or browser access failed", { checkpoint, collectionStage, timedOut: error instanceof Error && error.name === "TimeoutError" }, "warning");
  }
}
