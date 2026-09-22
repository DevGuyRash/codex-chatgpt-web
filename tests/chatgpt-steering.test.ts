import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptTurnExecutionKey, chatGptCompactionSourceExecutionKey, chatGptTurnInputLineage } from "../src/adapters/chatgpt-web/turn-execution";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import type { CodexParsedRequest } from "../src/types";

function request(steered = false): CodexParsedRequest {
  const input: unknown[] = [
    { type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Inspect the project" }] },
  ];
  if (steered) input.push(
    { type: "function_call", call_id: "call_read", name: "exec_command", arguments: '{"cmd":"cat input.json"}' },
    { type: "function_call_output", call_id: "call_read", output: "already executed" },
    { type: "message", role: "user", id: "msg_steer", content: [{ type: "input_text", text: "Also write steering.txt" }] },
  );
  return {
    modelId: "chatgpt-web/light", stream: true, context: { messages: [] }, options: {},
    _rawBody: { input, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test", turn_id: "turn_test" }) } },
  };
}

function runtime(browser: Promise<string>, physicalSettlement: Promise<void>, cancel: (reason?: Error) => void) {
  return { mode: "read-only" as const, browser, physicalSettlement, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel };
}

test("same-turn steering retires its exact predecessor, joins cleanup, and rejects delayed predecessor replay", async () => {
  const sessions = new ChatGptTurnSessions();
  let rejectBrowser!: (reason?: Error) => void;
  let settlePhysical!: () => void;
  let cancellations = 0;
  const oldRuntime = {
    ...runtime(new Promise((_, reject) => { rejectBrowser = reject; }), new Promise(resolve => { settlePhysical = resolve; }), reason => { cancellations++; rejectBrowser(reason); }),
    mode: "tools" as const, token: Promise.resolve("old-token"), externalProgress: new ChatGptExternalTurnProgress(),
  };
  const first = await sessions.getOrCreateAfterOwnerRetirement("old", "owner", () => oldRuntime, "old-trace", undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()));
  first.setOutstanding([{ callId: "call_read", wireName: "exec_command", freeform: false, arguments: { cmd: "cat input.json" } }]);
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "owner", () => {
    starts++;
    return runtime(Promise.resolve("corrected"), Promise.resolve(), () => {});
  }, "new-trace", undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request(true)));
  await Bun.sleep(0);
  expect(cancellations).toBe(1);
  expect(starts).toBe(0);
  settlePhysical();
  const next = await replacement;
  await next.browserOutcome;
  expect(starts).toBe(1);
  expect(first.outstanding()[0]?.callId).toBe("call_read");
  await expect(sessions.getOrCreateAfterOwnerRetirement("old", "owner", () => { throw new Error("must not restart"); }, "late-trace", undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()))).rejects.toMatchObject({ code: "chatgpt_turn_superseded", retryable: false });
  await sessions.retireAndWait("old");
  await expect(sessions.getOrCreateAfterOwnerRetirement("old", "owner", () => { throw new Error("must not restart without old entry"); }, "late-trace", undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()))).rejects.toMatchObject({ code: "chatgpt_turn_superseded" });
});

test("input lineage requires an unchanged prefix and ignores tool-result-only continuation", () => {
  const first = request();
  const continuation = structuredClone(first);
  (continuation._rawBody as { input: unknown[] }).input.push({ type: "function_call_output", call_id: "call_read", output: "already executed" });
  const original = chatGptTurnInputLineage(first);
  expect(chatGptTurnInputLineage(continuation)).toEqual(original);
  expect(chatGptTurnInputLineage(request(true)).ancestors.has(original.head)).toBeTrue();
  const foreign = request(true);
  (foreign._rawBody as { input: { content?: unknown }[] }).input[0]!.content = [{ type: "input_text", text: "A different original instruction" }];
  expect(chatGptTurnInputLineage(foreign).ancestors.has(original.head)).toBeFalse();
});

test.each(["different native turn", "different native thread", "changed input prefix"])("steering does not preempt an owner with %s", async variant => {
  const sessions = new ChatGptTurnSessions();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let cancellations = 0;
  await sessions.getOrCreateAfterOwnerRetirement("old", "owner", () => runtime(pending.then(() => "old"), pending, () => { cancellations++; }), undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()));
  const nextInput = request(true);
  if (variant === "changed input prefix") (nextInput._rawBody as { input: { id?: string }[] }).input[0]!.id = "msg_foreign";
  let starts = 0;
  const next = sessions.getOrCreateAfterOwnerRetirement("new", "owner", () => {
    starts++;
    return runtime(Promise.resolve("new"), Promise.resolve(), () => {});
  }, undefined, undefined, variant === "different native turn" ? "turn_next" : "turn_test", variant === "different native thread" ? "thread_next" : "thread_test", chatGptTurnInputLineage(nextInput));
  await Bun.sleep(0);
  expect(cancellations).toBe(0);
  expect(starts).toBe(0);
  finish();
  await next;
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
});

test("a terminal predecessor stays superseded when its replacement is subsequently retired", async () => {
  const sessions = new ChatGptTurnSessions();
  const start = () => runtime(Promise.resolve("done"), Promise.resolve(), () => {});
  const first = await sessions.getOrCreateAfterOwnerRetirement("old", "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()));
  await first.physicalSettlement;
  await sessions.getOrCreateAfterOwnerRetirement("new", "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request(true)));
  await sessions.retireAndWait("new");
  await expect(sessions.getOrCreateAfterOwnerRetirement("old", "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(request()))).rejects.toMatchObject({ code: "chatgpt_turn_superseded" });
});

test("repeated instruction text keeps distinct native message identities through steering and compaction", async () => {
  const first = request();
  const repeated = structuredClone(first);
  const input = (repeated._rawBody as { input: Array<Record<string, unknown>> }).input;
  input.push({ ...structuredClone(input[0]!), id: "msg_repeated" });
  const firstKey = chatGptTurnExecutionKey(first), repeatedKey = chatGptTurnExecutionKey(repeated);
  expect(repeatedKey).not.toBe(firstKey);
  const continuation = structuredClone(repeated);
  (continuation._rawBody as { input: unknown[] }).input.push({ type: "function_call_output", call_id: "call_later", output: "completed tool work" });
  expect(chatGptTurnExecutionKey(continuation)).toBe(repeatedKey);
  const compact = structuredClone(continuation); compact._compactionRequest = true;
  expect(chatGptCompactionSourceExecutionKey(compact)).toBe(repeatedKey);
  const sessions = new ChatGptTurnSessions();
  let starts = 0;
  const start = () => { starts++; return runtime(Promise.resolve("completed"), Promise.resolve(), () => {}); };
  const original = await sessions.getOrCreateAfterOwnerRetirement(firstKey, "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(first));
  await original.physicalSettlement;
  const next = await sessions.getOrCreateAfterOwnerRetirement(repeatedKey, "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(repeated));
  expect(next).not.toBe(original);
  expect(starts).toBe(2);
  await expect(sessions.getOrCreateAfterOwnerRetirement(firstKey, "owner", start, undefined, undefined, "turn_test", "thread_test", chatGptTurnInputLineage(first))).rejects.toMatchObject({ code: "chatgpt_turn_superseded" });
});
