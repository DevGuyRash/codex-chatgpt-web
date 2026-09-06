import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";

// Isolated process: substituting the CDP transport cannot affect other worker tests.
const host = await import("../../src/launcher-browser-host");
const calls: string[] = [];
let acquired = 0;
mock.module("../../src/launcher-browser-host", () => ({
  ...host,
  notifyLauncherTurn: async () => { calls.push("heartbeat"); return {}; },
  connectLauncherBrowserHost: async () => {
    const name = ++acquired === 1 ? "first" : "rebound";
    calls.push(`connect:${name}`);
    return {
      browser: { close: async () => { calls.push(`close:${name}`); } },
      page: { isClosed: () => false, waitForFunction: async () => {
        if (name === "rebound") throw new Error("Synthetic viewport failure");
      } },
    };
  },
}));
const { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError } = await import("../../src/adapters/chatgpt-web/browser-worker");
const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
  config: { browserHost: "launcher", browserHostDescriptorPath: "/synthetic/unused" },
  runStage: async (_trace: string, _stage: string, _timeout: number, action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
  selectModelAndEffort: async () => ({ effort: "medium", localTools: false }),
  captureSubmissionBaseline: async () => ({ initialResponseTurnIdentities: [], domCache: {} }),
  attachPromptWithCompactionRetry: async () => {},
  attachFiles: async () => {},
  sendAttachedPrompt: async (_page: Page, baseline: unknown, _capture: unknown, signal: AbortSignal, _progress: unknown, _turn: unknown, _tracker: unknown,
    recover: (attempt: number, error: Error, baseline: unknown, signal: AbortSignal) => Promise<unknown>) => {
    calls.push("recover-before-submission");
    return recover(1, new ChatGptBrowserObservationTimeoutError(1), baseline, signal);
  },
}) as { runBrowserTurn(turn: unknown, surface: string, page: undefined, reused: boolean): Promise<string> };
await assert.rejects(worker.runBrowserTurn({
  traceId: "rebind-ownership-fixture", modelId: "gpt-5.6-sol", reasoning: "medium",
  capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  prepare: async () => { throw new Error("Must use the continuation"); },
  prepareResume: async () => ({ text: "Synthetic continuation", images: [], release: () => { calls.push("release"); } }),
}, "synthetic-surface", undefined, true), /Synthetic viewport failure/);
assert.deepEqual(calls, ["connect:first", "recover-before-submission", "close:first", "heartbeat", "connect:rebound", "release", "close:rebound"]);
console.log("REBIND_OWNERSHIP_OK");
