import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { isProGeneration } from "../src/campaign-policy";
import { probeUnsentSelection } from "../scripts/golden/admission-probe";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const route = CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/light")!;
const input = { route, capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false }, traceId: "fixture_probe", signal: new AbortController().signal, onReady: async () => {} };

test("an unsent probe requires exact cancellation after readiness and draft release", async () => {
  let sendPermission = false;
  const client = { run: async (turn: BrowserTurn) => {
    const prepared = await turn.prepare();
    try { await turn.onSendActivated?.(); sendPermission = true; return "Unexpected response"; }
    finally { prepared.release(); }
  } };
  expect(await probeUnsentSelection({ ...input, client })).toEqual({ selectionReady: true, sendPermission: "withheld", submitted: false });
  expect(sendPermission).toBe(false);
});

for (const settlement of ["missing-release", "submitted", "wrong-abort", "cleanup-failed", "unexpected-result"] as const) test(`an unsent probe cannot infer readiness from ${settlement}`, async () => {
  const client = { run: async (turn: BrowserTurn) => {
    const prepared = await turn.prepare();
    try {
      if (settlement === "submitted") turn.onSubmitted?.();
      await turn.onSendActivated?.();
      return "Unexpected response";
    } catch (error) {
      if (settlement === "wrong-abort") throw new DOMException("Unrelated abort", "AbortError");
      if (settlement === "cleanup-failed") throw new Error("Cleanup did not settle");
      if (settlement === "unexpected-result") return "Unexpected response";
      throw error;
    } finally { if (settlement !== "missing-release") prepared.release(); }
  } };
  await expect(probeUnsentSelection({ ...input, client })).rejects.toThrow();
});

test("selection probing cannot admit Pro or tool work", async () => {
  let called = false;
  const client = { run: async () => { called = true; return "Forbidden"; } };
  await expect(probeUnsentSelection({ ...input, client, route: CHATGPT_WEB_MODEL_ROUTES.find(isProGeneration)! })).rejects.toThrow("non-Pro");
  await expect(probeUnsentSelection({ ...input, client, capabilities: { ...input.capabilities, localToolsEnabled: true } })).rejects.toThrow("without tools");
  expect(called).toBe(false);
});
