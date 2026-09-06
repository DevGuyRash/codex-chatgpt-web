import type { Page } from "playwright-core";
import { runtimeCaptureClient, runtimeDiagnostics } from "./runtime";

/** Fail closed on login, settings, embedded frames, and modal/credential surfaces. No DOM is retained. */
export async function isPrivateCaptureSurface(page: Page): Promise<boolean> {
  try {
    const url = new URL(page.url());
    if (url.origin !== "https://chatgpt.com" || !/^\/(?:c\/[a-zA-Z0-9-]+)?\/?$/.test(url.pathname) || page.frames().length !== 1) return false;
    return await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      // Generic text controls can also be username/credential fields. Extra visible inputs fail closed.
      const blocked = document.querySelectorAll('input,[role="dialog"],dialog[open],iframe,textarea:not(#prompt-textarea)');
      if ([...blocked].some(visible)) return false;
      return [...document.querySelectorAll('#prompt-textarea[contenteditable="true"],textarea#prompt-textarea')].some(visible);
    });
  } catch { return false; }
}

export async function captureBrowserCheckpoint(page: Page, checkpoint: string, failed: boolean): Promise<void> {
  const diagnostics = runtimeDiagnostics(); const context = diagnostics?.context();
  diagnostics?.event("browser.checkpoint", "Browser stage checkpoint", { checkpoint, failed }, failed ? "warning" : "debug");
  if (!diagnostics || !context) return;
  const client = runtimeCaptureClient();
  if (!client || !client.privateCaptureEnabled()) return;
  try {
    if (!await client.claimCapture(context.traceId)) return;
    if (!await isPrivateCaptureSurface(page)) {
      diagnostics.event("capture.excluded", "Private capture omitted on an authentication, modal, or unrecognized surface", { checkpoint }, "warning"); return;
    }
    const png = await page.screenshot({ animations: "disabled", caret: "hide", timeout: 3000, type: "png" });
    if (!await isPrivateCaptureSurface(page)) {
      diagnostics.event("capture.excluded", "Private capture discarded because the browser surface changed", { checkpoint }, "warning"); return;
    }
    const result = await client.writeCapture(context.traceId, png);
    diagnostics.event("capture.result", result.status === "stored" ? "Private image stored separately; excluded from ordinary exports" : "Private image was not retained", { checkpoint, result: result.status, ...(result.status === "omitted" ? { reason: result.reason } : { expires: result.expires }) }, result.status === "stored" ? "info" : "warning");
  } catch {
    diagnostics.event("capture.failed", "Private capture was not retained; collection or browser access failed", { checkpoint }, "warning");
  }
}
