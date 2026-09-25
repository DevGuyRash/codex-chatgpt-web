import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

// Keep the transport replacement isolated from other browser-worker tests.
const host = await import("../../src/launcher-browser-host");
const calls: string[] = [];
let firstConnected = true;
let acquired = 0;
const hidden = {
  filter() { return this; }, last() { return this; }, getByText() { return this; },
  isVisible: async () => false, count: async () => 1,
};
const firstPage = {
  isClosed: () => !firstConnected,
  locator: () => hidden,
  waitForFunction: async () => {},
  evaluate: async () => ({}),
} as unknown as Page;
const reboundPage = {
  isClosed: () => false,
  locator: () => hidden,
  waitForFunction: async () => {},
  evaluate: async () => ({}),
} as unknown as Page;
mock.module("../../src/launcher-browser-host", () => ({
  ...host,
  notifyLauncherTurn: async () => { calls.push("heartbeat"); return {}; },
  connectLauncherBrowserHost: async () => {
    const first = ++acquired === 1;
    calls.push(first ? "connect:first" : "connect:rebound");
    return {
      browser: { isConnected: () => first ? firstConnected : true,
        close: async () => { calls.push(first ? "close:first" : "close:rebound"); } },
      page: first ? firstPage : reboundPage,
    };
  },
}));
const { ChatGptBrowserWorker } = await import("../../src/adapters/chatgpt-web/browser-worker");
const observedAfterRebind = new Error("fixture reached the rebound response");
let reads = 0;
const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
  config: { browserHost: "launcher", browserHostDescriptorPath: "/synthetic/owned", appName: "Codex Native2" },
  runStage: async (_trace: string, _stage: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
  selectModelAndEffort: async () => ({ effort: "medium", localTools: false }),
  captureSubmissionBaseline: async () => ({ initialUserTurnIdentities: [], initialResponseTurnIdentities: [], domCache: {} }),
  attachPromptWithCompactionRetry: async () => { calls.push("attach:once"); },
  attachFiles: async () => {},
  sendAttachedPrompt: async () => { calls.push("send:once"); return "user_turn"; },
  waitForNewAssistantTurn: async () => ({ identity: "assistant", locator: hidden, acceptedUserTurnIdentities: [] }),
  responseDomSnapshot: async () => {
    reads += 1;
    if (reads === 1) { firstConnected = false; throw new Error("CDP transport disconnected"); }
    calls.push("read:rebound");
    throw observedAfterRebind;
  },
}) as { runBrowserTurn(turn: unknown, surface: string, page: undefined, reused: boolean): Promise<string> };
await assert.rejects(worker.runBrowserTurn({
  traceId: "disconnected-continuation-fixture", modelId: "gpt-5.6-sol", reasoning: "medium",
  capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  prepare: async () => { throw new Error("Must continue the retained task"); },
  prepareResume: async () => ({ text: "Synthetic continuation", images: [], release: () => calls.push("release") }),
}, "owned-surface", undefined, true), error => error === observedAfterRebind);
assert.equal(reads, 2);
assert.equal(calls.filter(call => call === "send:once").length, 1);
assert.equal(calls.filter(call => call === "connect:first").length, 1);
assert.equal(calls.filter(call => call === "connect:rebound").length, 1);
assert.equal(calls.includes("close:first"), false);
assert.equal(calls.includes("close:rebound"), true);
console.log("DISCONNECTED_CONTINUATION_OWNERSHIP_OK");
