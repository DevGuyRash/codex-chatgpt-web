import { afterEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import type { BrowserTurn, ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { runtimeDiagnostics, setRuntimeDiagnostics } from "../src/diagnostics/runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("multiplexed helper callbacks retain each submitting task's diagnostic context", async () => {
  const diagnostics = new Diagnostics({ emit() {} }, { component: "runtime", target: "fixture", environment: "test" });
  const prior = runtimeDiagnostics(); setRuntimeDiagnostics(diagnostics);
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native", browserHost: "launcher", browserHostDescriptorPath: "/fixture/launcher.json", storageStatePath: "/fixture/unused.json", chromeExecutablePath: "/fixture/chrome", turnTimeoutMs: 60_000, headed: false, autoApproveToolCalls: false });
  const internal = client as unknown as { child: unknown; ensureChild(): Promise<void>; send(message: Record<string, unknown>): Promise<void>; handleLine(child: unknown, line: string): void };
  const child = {}; internal.child = child; internal.ensureChild = async () => {};
  const sent: Record<string, unknown>[] = []; internal.send = async message => { sent.push(message); };
  const foreign = diagnostics.begin("helper.shared_pipe", {}, null);
  const owners = [diagnostics.begin("http.responses", {}, null), diagnostics.begin("http.responses", {}, null)];
  const observed = owners.map(() => [] as (string | undefined)[]);
  const receive = (id: string, message: Record<string, unknown>) => foreign.run(() => internal.handleLine(child, JSON.stringify({ id, ...message })));
  const turns = owners.map((owner, index) => owner.run(() => client.run({
    traceId: `task-${index}`, modelId: "gpt-5.6-sol", reasoning: "low", capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    prepare: async () => { await Promise.resolve(); observed[index].push(diagnostics.context()?.traceId); return { text: "work", images: [], release: () => { observed[index].push(diagnostics.context()?.traceId); } }; },
    onSendActivated: async () => { await Promise.resolve(); observed[index].push(diagnostics.context()?.traceId); },
    onSubmitted: () => { observed[index].push(diagnostics.context()?.traceId); },
    onTextDelta: () => { observed[index].push(diagnostics.context()?.traceId); },
  })));
  try {
    for (let spin = 0; spin < 100 && sent.filter(frame => frame.type === "run").length < 2; spin++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(sent.filter(frame => frame.type === "run")).toHaveLength(2);
    for (const index of [1, 0]) receive(`task-${index}`, { type: "event", event: "prepared_selected", reused: false });
    for (let spin = 0; spin < 100 && sent.filter(frame => frame.type === "prepared_selected_ack").length < 2; spin++) await new Promise(resolve => setTimeout(resolve, 1));
    expect(sent.filter(frame => frame.type === "prepared_selected_ack")).toHaveLength(2);
    for (const index of [0, 1]) receive(`task-${index}`, { type: "event", event: "send_activated" });
    for (let spin = 0; spin < 100 && sent.filter(frame => frame.type === "send_activation_ack").length < 2; spin++) await new Promise(resolve => setTimeout(resolve, 1));
    for (const index of [1, 0]) {
      receive(`task-${index}`, { type: "event", event: "submitted" });
      receive(`task-${index}`, { type: "event", event: "text", text: "done" });
      receive(`task-${index}`, { type: "result", text: "done" });
    }
    expect(await Promise.all(turns)).toEqual(["done", "done"]);
    expect(observed).toEqual(owners.map(owner => Array(5).fill(owner.context.traceId)));
  } finally {
    internal.child = undefined;
    await client.close(); await Promise.allSettled(turns);
    owners.forEach(owner => owner.end()); foreign.end(); await diagnostics.close(); setRuntimeDiagnostics(prior);
  }
});

test("daemon streams browser lifecycle through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Substitute only the browser. Both sides of the production IPC protocol run unchanged.
    ChatGptBrowserWorker.prototype.run = async turn => {
      await turn.onPreparedSelected(false);
      const prepared = await turn.prepare();
      if (prepared.multipart.parts.length !== 6) throw new Error("Multipart context was lost");
      await turn.onMultipartStageAcknowledged?.(1);
      await turn.onMultipartStageAcknowledged?.(2);
      await turn.onMultipartStageAcknowledged?.(3);
      await turn.onMultipartStageAcknowledged?.(4);
      await turn.onMultipartStageAcknowledged?.(5);
      await turn.onSendActivated();
      turn.onSubmitted();
      turn.onReasoningSummary("Reading project");
      turn.onReasoningSummary(" files", true);
      turn.onTextDelta("done");
      if (turn.captureLunaCheckpoint) turn.onLunaCheckpoint({
        answerHash: "a".repeat(64),
        checkpoint: {
          version: 1,
          objective: "Finish the helper test.",
          state: ["The answer streamed."],
          evidence: ["The helper emitted a checkpoint event."],
          decisions: [],
          pending: [],
        },
      });
      return "done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "owned_native_target_0123456789abcdef" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  const checkpoints: unknown[] = [];
  const acknowledgedStages: number[] = [];
  let sendActivated = false;
  let submitted = false;
  let released = false;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({
        text: "inspect", images: [],
        multipart: { parts: ["part one", "part two", "part three", "part four", "part five", "part six"], commit: "inspect" },
        release: () => { released = true; },
      }),
      onMultipartStageAcknowledged: stage => { acknowledgedStages.push(stage); },
      onSendActivated: () => { sendActivated = true; },
      onSubmitted: () => { submitted = true; },
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
      captureLunaCheckpoint: true,
      onLunaCheckpoint: checkpoint => checkpoints.push(checkpoint),
    });
    expect(result).toBe("done");
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(sendActivated).toBe(true);
    expect(submitted).toBe(true);
    expect(acknowledgedStages).toEqual([1, 2, 3, 4, 5]);
    expect(checkpoints).toEqual([{
      answerHash: "a".repeat(64),
      checkpoint: {
        version: 1,
        objective: "Finish the helper test.",
        state: ["The answer streamed."],
        evidence: ["The helper emitted a checkpoint event."],
        decisions: [],
        pending: [],
      },
    }]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("launcher helper protocol preserves multipart context and the compaction flag", async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native2 DEV",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    pending: Map<string, { resolve(value: string): void }>;
    child?: unknown;
    ensureChild(): Promise<void>;
    send(message: Record<string, unknown>): Promise<void>;
    finish(id: string): void;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  internal.ensureChild = async () => {};
  internal.send = async message => {
    sent.push(message);
    if (typeof message.id !== "string") return;
    if (message.type === "run") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "event",
        id: message.id,
        event: "prepared_selected",
        reused: false,
      })));
    } else if (message.type === "prepared_selected_ack") {
      queueMicrotask(() => internal.handleLine(child, JSON.stringify({
        type: "result",
        id: message.id,
        text: "done",
      })));
    }
  };

  await expect(client.run({
    traceId: "multipart-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    compaction: true,
    prepare: async () => ({
      text: "commit",
      images: [],
      multipart: { parts: ["{\"part\":1}", "{\"part\":2}"], commit: "commit" },
      trimmedCompactionMessages: 4,
      release() {},
    }),
    onTextDelta() {},
  })).resolves.toBe("done");

  expect(sent[0]).toMatchObject({
    type: "run",
    turn: {
      compaction: true,
    },
  });
  expect(sent[1]).toMatchObject({
    type: "prepared_selected_ack",
    prepared: {
        text: "commit",
        multipart: { parts: ["{\"part\":1}", "{\"part\":2}"], commit: "commit" },
        trimmedCompactionMessages: 4,
    },
  });
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(false);
});

test("structured helper errors preserve the ChatGPT adapter failure contract", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    child?: unknown;
    pending: Map<string, {
      turn: BrowserTurn;
      runInContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    }>;
    handleLine(child: unknown, line: string): void;
  };
  const child = {};
  internal.child = child;
  const result = new Promise<string>((resolveResult, rejectResult) => {
    internal.pending.set("rate-limit-123", {
      runInContext: AsyncLocalStorage.snapshot(),
      turn: {
        traceId: "rate-limit-123",
        modelId: "chatgpt-web/medium",
        capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
        prepare: async () => ({ text: "inspect", images: [], release() {} }),
        onTextDelta() {},
      },
      resolve: resolveResult,
      reject: rejectResult,
    });
  });

  internal.handleLine(child, JSON.stringify({
    type: "error",
    id: "rate-limit-123",
    name: "ChatGptWebAdapterError",
    message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
    problem: { version: 1, code: "rate_limit_exceeded", message: "Provider reported a rate limit", origin: "browser-helper", stage: "browser.turn", httpStatus: 429, retryable: true, causes: [{ code: "provider_limit", message: "Retry after reset" }], stack: "Error: provider limit\n    at browser-turn", recovery: "not-needed", actions: [], findings: [] },
  }));

  const error = await result.then(() => undefined, failure => failure);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error.problem).toMatchObject({ origin: "browser-helper", stage: "browser.turn", httpStatus: 429, causes: [{ code: "provider_limit", message: "Retry after reset" }] });
  expect(error).toMatchObject({
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
});

for (const settlement of ["aborted", "cleanup-failed", "completed"] as const) test(`rejected Send activation preserves helper settlement: ${settlement}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "helper-send-veto-")); roots.push(root);
  const helper = join(root, "helper.ts"), descriptorPath = join(root, "launcher.json");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    ChatGptBrowserWorker.prototype.run = async turn => {
      await turn.onPreparedSelected(false); await turn.prepare();
      try { await turn.onSendActivated(); throw new Error("Rejected Send was acknowledged"); }
      catch (error) {
        if (${JSON.stringify(settlement)} === "cleanup-failed") throw new Error("Synthetic helper cleanup failed");
        if (${JSON.stringify(settlement)} === "completed") return "Unexpected completion";
        throw error;
      }
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  writeFileSync(descriptorPath, JSON.stringify({ version: 3, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "production", pid: process.pid, endpoint: "http://127.0.0.1:39001", control: { endpoint: "http://127.0.0.1:39002", token: "launcher-control-token-0123456789abcdefghijklmnop" }, helper: { executable: process.execPath, script: helper }, partition: "persist:codex-web-gpt-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "launcher_surface_id_0123456789AB", surfaceTargets: { launcher_surface_id_0123456789AB: "owned_native_target_0123456789abcdef" }, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({ appName: "Codex Native2", browserHost: "launcher", browserHostDescriptorPath: descriptorPath, browserHelperScriptPath: helper, storageStatePath: join(root, "unused"), chromeExecutablePath: join(root, "unused-chrome"), turnTimeoutMs: 10000, headed: true, autoApproveToolCalls: false });
  const veto = new DOMException("Draft must remain unsent", "AbortError");
  let released = false, activated = 0, submitted = false, failure: unknown;
  try {
    try { await client.run({ traceId: "send_veto_fixture", modelId: "gpt-5.6-sol", reasoning: "low", capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false }, prepare: async () => ({ text: "Unsent synthetic draft", images: [], release: () => { released = true; } }), onSendActivated: () => { activated++; throw veto; }, onSubmitted: () => { submitted = true; }, onTextDelta: () => {} }); }
    catch (error) { failure = error; }
    expect(activated).toBe(1); expect(submitted).toBe(false); expect(released).toBe(true);
    if (settlement === "aborted") expect(failure).toBe(veto);
    else expect(failure).toMatchObject({ code: "browser_helper_cancellation_unconfirmed", retryable: false });
  } finally { await client.close(); }
});
