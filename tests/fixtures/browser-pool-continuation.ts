import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { LauncherBrowserConnectionPool, type LauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";

const descriptor = { pid: 42, endpoint: "http://127.0.0.1:9000", partition: "persist:codex-web-gpt-chatgpt", createdAt: "2026-09-28T00:00:00.000Z" } as LauncherBrowserHostDescriptor;
const events = new EventEmitter();
const hidden = { filter() { return this; }, last() { return this; }, getByText() { return this; }, isVisible: async () => false, count: async () => 1 };
const page = {
  isClosed: () => false,
  url: () => "https://chatgpt.com/?temporary-chat=true",
  locator: () => hidden,
  waitForFunction: async () => {},
  on: events.on.bind(events),
  off: events.off.bind(events),
} as unknown as Page;
let connects = 0, closes = 0;
const pool = new LauncherBrowserConnectionPool(2, {
  read: () => descriptor,
  connect: async () => {
    connects++;
    let connected = true;
    const browser = { isConnected: () => connected, close: async () => { connected = false; closes++; } } as unknown as Browser;
    return { descriptor, browser, context: {} as BrowserContext, page };
  },
  select: async () => ({ context: {} as BrowserContext, page }),
});
const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
  config: { browserHost: "launcher", browserHostDescriptorPath: "/synthetic/owned", appName: "Codex Native2" },
  launcherConnections: pool,
  runStage: async (_trace: string, _stage: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
  prepareTemporaryChatSurface: async () => {},
  selectModelAndEffort: async () => ({ effort: "medium", localTools: false }),
  assertSelectedEffort: async () => {},
  captureSubmissionBaseline: async () => ({ initialUserTurnIdentities: [], initialResponseTurnIdentities: [], domCache: {} }),
  attachPromptWithCompactionRetry: async () => {},
  attachFiles: async () => {},
  sendAttachedPrompt: async (_page: Page, _baseline: unknown, _capture: unknown, _signal: AbortSignal, _progress: unknown, lifecycle: { onSendActivated?: () => Promise<void> }) => {
    await lifecycle.onSendActivated?.();
    return "user_turn";
  },
  waitForNewAssistantTurn: async () => ({ identity: "assistant", locator: hidden, acceptedUserTurnIdentities: [] }),
  responseDomSnapshot: async () => ({
    responsePresent: true,
    visibleText: "Synthetic answer",
    fullHtml: "<p>Synthetic answer</p>",
    markdownSegments: [{ key: "0:p", tag: "p", html: "<p>Synthetic answer</p>", text: "Synthetic answer", streamable: false }],
    completionActionVisible: true,
    stoppedThinkingVisible: false,
    traceBlocks: [],
  }),
}) as { runBrowserTurn(turn: unknown, surface: string, page: undefined, reused: boolean): Promise<string> };

try {
  for (const traceId of ["pooled-turn-one", "pooled-turn-two"]) {
    const deltas: string[] = [];
    const result = await worker.runBrowserTurn({
      traceId, modelId: "gpt-5.6-sol", reasoning: "medium",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "Synthetic instruction", images: [], release: () => {} }),
      onTextDelta: (text: string) => deltas.push(text),
    }, "owned-surface", undefined, false);
    assert.equal(result, "Synthetic answer");
    assert.equal(deltas.join(""), "Synthetic answer");
  }
  assert.equal(connects, 1);
  assert.equal(closes, 0);
  await pool.close();
  assert.equal(closes, 1);
  console.log("POOLED_TURN_OWNERSHIP_OK");
} finally { await pool.close(); }
