import { extractChatGptTurnUserRevisionIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { problemFor } from "../src/diagnostics/problems";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoldenAppServer } from "../scripts/golden/app-server";
import { findNativeScenarioFailure, NativeScenarioFailure, runStructuredScenario } from "../scripts/golden/structured-scenarios";
import { createWorkload } from "../scripts/golden/workloads";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { bridgeToResponsesSSE } from "../src/bridge";
import { chatGptHtmlToMarkdown } from "../src/adapters/chatgpt-web/markdown";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { adapterErrorEvent } from "../src/lib/errors";
import type { AdapterEvent } from "../src/types";

async function fixture(output: (requestNumber: number) => AsyncIterable<AdapterEvent>, observe?: (frame: { direction: string; message: Record<string, any> }) => void) {
  const root = mkdtempSync(join(tmpdir(), "golden-consumer-")), home = join(root, "codex");
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize isolated native fixture");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!; let requests = 0, stderr = "";
  const frames: { direction: string; message: Record<string, any> }[] = [], bodies: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/responses") return new Response("fixture endpoint only", { status: 404 });
    bodies.push(await request.json());
    return new Response(bridgeToResponsesSSE(output(++requests), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `[model_providers.golden_fixture]\nname = "Loopback synthetic fixture"\nbase_url = "http://127.0.0.1:${server.port}"\nwire_api = "responses"\nrequires_openai_auth = false\nstream_max_retries = 0\nrequest_max_retries = 0\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const app = new GoldenAppServer({ executable: process.env.CODEX_TEST_PROFILE_BINARY!, cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, route, modelProvider: "golden_fixture",
    onFrame: frame => { frames.push(frame); observe?.(frame); }, onStderr: text => { stderr = (stderr + text).slice(-8192); } });
  const close = async () => { try { await app.close(100); } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); } };
  try { await app.initialize(); await app.openThread(); }
  catch (error) { await close(); throw new Error(`${String(error)}: ${stderr}`); }
  return { app, frames, bodies, close, requests: () => requests };
}

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("continued native scenario retains its preparatory conversation in the same process and task", async () => {
  const f = await fixture(async function* (number) {
    yield { type: "text_delta", text: number === 1 ? "Prepared synthetic continuation witness." : "Synthetic continuation completed.", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  });
  try {
    const result = await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-continued-scenario", batch: 0 }), variant: "continued", signal: new AbortController().signal, timeoutMs: 10000, checkpoint: () => {} });
    expect(result.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
    expect(f.requests()).toBe(2);
    expect(JSON.stringify(f.bodies[1])).toContain("Prepared synthetic continuation witness.");
    const starts = f.frames.filter(frame => frame.direction === "sent" && frame.message.method === "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[0]!.message.params.threadId).toBe(starts[1]!.message.params.threadId);
  } finally { await f.close(); }
}, 120000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native model switching preserves preparation while changing the requested route in the same task", async () => {
  const f = await fixture(async function* (number) {
    yield { type: "text_delta", text: number === 1 ? "Retain this synthetic model-switch witness." : "Switched continuation completed.", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  });
  const modelSwitch = { from: CHATGPT_WEB_MODEL_ROUTES[1]!, to: CHATGPT_WEB_MODEL_ROUTES[0]! };
  try {
    const result = await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-switch-scenario", batch: 0 }), variant: "model-switch", modelSwitch, signal: new AbortController().signal, timeoutMs: 10000, checkpoint: () => {} });
    expect(result).toMatchObject({ modelSwitch: { from: modelSwitch.from.slug, to: modelSwitch.to.slug } });
    expect(result.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
    expect(new Set(result.turns.map(turn => turn.id)).size).toBe(2);
    expect(f.requests()).toBe(2);
    expect(JSON.stringify(f.bodies[1])).toContain("Retain this synthetic model-switch witness.");
    expect(f.bodies.map(body => (body as any).model)).toEqual([modelSwitch.from.slug, modelSwitch.to.slug]);
    const starts = f.frames.filter(frame => frame.direction === "sent" && frame.message.method === "turn/start");
    expect(new Set(starts.map(frame => frame.message.params.threadId)).size).toBe(1);
    expect(starts.map(frame => frame.message.params.effort)).toEqual([modelSwitch.from.codexEffort, modelSwitch.to.codexEffort]);
  } finally { await f.close(); }
}, 120000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native Plan events survive HTML conversion and streamed delimiters, revision and subsequent execution", async () => {
  const f = await fixture(async function* (number) {
    const text = number <= 2 ? chatGptHtmlToMarkdown(`<p>&lt;proposed_plan&gt;</p><h1>Plan revision ${number}</h1><p>Reconcile the synthetic orders and validate the artifacts.</p><p>&lt;/proposed_plan&gt;</p>`) : "Execution completed for the synthetic fixture.";
    for (let offset = 0; offset < text.length; offset += 7) yield { type: "text_delta", text: text.slice(offset, offset + 7), phase: "final_answer" };
    yield { type: "done", endTurn: true, usage: { inputTokens: 12, outputTokens: 6 } };
  });
  try {
    const checkpoints: string[] = [];
    const result = await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-plan-scenario", batch: 0 }), variant: "plan-revise-execute", signal: new AbortController().signal, timeoutMs: 10000, checkpoint: value => { checkpoints.push(value.turnId); } });
    expect(result.turns.map(turn => turn.status)).toEqual(["completed", "completed", "completed"]);
    expect(new Set(checkpoints).size).toBe(3);
    const plans = f.frames.filter(frame => frame.direction === "received" && frame.message.method === "item/completed" && frame.message.params.item.type === "plan");
    expect(plans).toHaveLength(2);
    expect(plans.map(frame => frame.message.params.item.text)).toEqual([expect.stringContaining("Plan revision 1"), expect.stringContaining("Plan revision 2")]);
    expect(f.frames.some(frame => frame.message.method === "item/plan/delta")).toBe(true);
    expect(f.requests()).toBe(3);
  } finally { await f.close(); }
}, 20000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("generation steering waits for native output and carries its correction into the same task", async () => {
  let release!: () => void, steerId: number | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async function* (number) {
    if (number === 1) {
      yield { type: "text_delta", text: "Working through the synthetic reconciliation.", phase: "final_answer" };
      await waiting;
    } else yield { type: "text_delta", text: "The synthetic steering correction was received.", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  }, frame => {
    if (frame.direction === "sent" && frame.message.method === "turn/steer") steerId = frame.message.id;
    if (frame.direction === "received" && steerId !== undefined && frame.message.id === steerId) release();
  });
  try {
    const result = await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-steer-scenario", batch: 0 }), variant: "steer-generation", signal: new AbortController().signal, timeoutMs: 10000, checkpoint: () => {} });
    expect(result.turns.map(turn => turn.status)).toEqual(["completed"]);
    expect(result.observation).toMatchObject({ threadId: f.app.state().threadId, phase: "generation" });
    expect(result.steeringWitness).toBeString();
    expect(f.bodies.length).toBe(2);
    expect(JSON.stringify(f.bodies[1])).toContain(result.steeringWitness!);
  } finally { release(); await f.close(); }
}, 20000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native consumer reports local browser failure without claiming provider capacity", async () => {
  const f = await fixture(async function* () {
    yield adapterErrorEvent(new ChatGptWebAdapterError("Local browser connection temporarily unavailable", { status: 502, errorType: "server_error", code: "browser_disconnected", retryable: false, cause: new Error("Synthetic CDP disconnect") }));
  });
  try {
    const turn = await f.app.startTurn({ text: "Exercise the synthetic local browser disconnect." });
    const terminal = await f.app.waitForCompletion(turn.id, { timeoutMs: 10000 });
    expect(terminal.status).toBe("failed");
    expect(JSON.stringify(terminal.error)).toContain("Local browser connection temporarily unavailable");
    expect(JSON.stringify(f.frames)).not.toContain("server_is_overloaded");
    expect(f.requests()).toBe(1);
  } finally { await f.close(); }
}, 15000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("interrupting a streamed native plan remains interrupted and permits the next execution turn", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async function* (number) {
    if (number === 1) {
      yield { type: "text_delta", text: "<proposed_plan>\n# Partial synthetic plan\nReconcile the orders", phase: "final_answer" };
      await waiting;
      return;
    }
    yield { type: "text_delta", text: "Subsequent synthetic execution completed.", phase: "final_answer" };
    yield { type: "done", endTurn: true };
  });
  try {
    const result = await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-interrupt-scenario", batch: 0 }), variant: "plan-stream-interrupt", signal: new AbortController().signal, timeoutMs: 10000, checkpoint: () => {} });
    expect(result.turns.map(turn => turn.status)).toEqual(["interrupted", "completed"]);
    expect(f.requests()).toBe(2);
  } finally { release(); await f.close(); }
}, 20000);

for (const variant of ["continued", "steer-generation"] as const) test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)(`native ${variant} preserves typed account failure before another submission`, async () => {
  const f = await fixture(async function* () {
    yield adapterErrorEvent(new ChatGptWebAdapterError("Synthetic account limit", { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true }));
  });
  try {
    let failure: unknown;
    try { await runStructuredScenario({ app: f.app, workload: createWorkload({ level: 1, seed: "native-account-limit", batch: 0 }), variant, signal: new AbortController().signal, timeoutMs: 10000, checkpoint: () => {} }); }
    catch (error) { failure = error; }
    expect(problemFor(failure)).toMatchObject({ code: "rate_limit_exceeded", httpStatus: 429, retryable: true });
    expect(failure).toMatchObject({ nativeFailure: { threadId: f.app.state().threadId, turns: [{ status: "failed", error: { codexErrorInfo: "rateLimitExceeded" } }] } });
    expect(f.requests()).toBe(1);
  } finally { await f.close(); }
}, 20000);

test("native account evidence survives an independent cleanup failure without erasing it", () => {
  const native = new NativeScenarioFailure("owned-thread", [{ id: "owned-turn", status: "failed", items: [], error: { codexErrorInfo: "rateLimitExceeded" } }]);
  const cleanup = new Error("Synthetic cleanup failure");
  const combined = new AggregateError([native, cleanup], "Cleanup did not settle");
  expect(findNativeScenarioFailure(combined)).toBe(native);
  expect(combined.errors).toContain(cleanup);
  expect(problemFor(combined)).toMatchObject({ code: "rate_limit_exceeded", httpStatus: 429, retryable: true });
  expect(JSON.stringify(problemFor(combined))).not.toContain("Synthetic cleanup failure");
  expect(findNativeScenarioFailure(new Error("rateLimitExceeded"))).toBeUndefined();
});

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native repeated-text steering supplies a distinct stable user message identity", async () => {
  let release!: () => void, steerId: number | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async function* (number) {
    yield { type: "text_delta", text: "Synthetic repeated instruction response.", phase: "final_answer" };
    if (number === 1) await waiting;
    yield { type: "done", endTurn: true };
  }, frame => {
    if (frame.direction === "sent" && frame.message.method === "turn/steer") steerId = frame.message.id;
    if (frame.direction === "received" && steerId !== undefined && frame.message.id === steerId) release();
  });
  try {
    const threadId = f.app.state().threadId!, prompt = "Inspect the synthetic project again.";
    const phase = f.app.rpc.waitFor("item/agentMessage/delta", params => params.threadId === threadId && typeof params.delta === "string" && params.delta.length > 0, { timeoutMs: 10000 });
    const turn = await f.app.startTurn({ text: prompt });
    await phase;
    await f.app.steer(turn.id, { text: prompt });
    expect((await f.app.waitForCompletion(turn.id, { timeoutMs: 10000 })).status).toBe("completed");
    expect(f.bodies).toHaveLength(2);
    const parsed = (body: unknown) => ({ modelId: CHATGPT_WEB_MODEL_ROUTES[0]!.slug, stream: true, context: { messages: [] }, options: {},
      _rawBody: { ...(body as Record<string, unknown>), client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turn.id }) } },
    });
    const firstRevision = extractChatGptTurnUserRevisionIdentity(parsed(f.bodies[0])), nextRevision = extractChatGptTurnUserRevisionIdentity(parsed(f.bodies[1]));
    expect(nextRevision.content).toEqual(firstRevision.content);
    expect(firstRevision.messageId).toBeString();
    expect(nextRevision.messageId).toBeString();
    expect(nextRevision.messageId).not.toBe(firstRevision.messageId);
    const firstKey = chatGptTurnExecutionKey(parsed(f.bodies[0])), nextKey = chatGptTurnExecutionKey(parsed(f.bodies[1]));
    expect(nextKey).not.toBe(firstKey);
    expect(chatGptTurnExecutionKey(parsed(structuredClone(f.bodies[1])))).toBe(nextKey);
  } finally { release(); await f.close(); }
}, 20000);
