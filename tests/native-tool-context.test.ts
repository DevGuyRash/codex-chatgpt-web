import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptNativeToolContext, type ChatGptTurnToolContext } from "../src/adapters/chatgpt-web/environment";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { callTurnBroker, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "cgw-native-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fn = (name: string) => ({ type: "function", name, description: `Native ${name}`, parameters: { type: "object", properties: {} }, strict: false });
function body() {
  return {
    model: CHATGPT_WEB_MODEL_ID,
    client_metadata: { "x-codex-turn-metadata": {
      request_kind: "turn", thread_source: "system", agent_name: "/root", sandbox: "seccomp", sandbox_mode: "read-only",
      thread_id: crypto.randomUUID(), turn_id: crypto.randomUUID(),
    } as Record<string, unknown> },
    input: [
      { type: "additional_tools", id: "at_native", role: "developer", tools: [fn("request_user_input_async"),
        { type: "namespace", name: "clock", tools: [fn("curr_time"), fn("sleep")] },
        { type: "namespace", name: "collaboration", tools: ["followup_task", "interrupt_agent", "list_agents", "send_message", "spawn_agent", "wait_agent"].map(fn) },
      ] },
      { type: "message", id: "msg_environment", role: "user", content: [{ type: "input_text", text: "<environment_context><shell>zsh</shell><current_date>2026-09-08</current_date></environment_context>" }] },
      { type: "message", id: "msg_instruction", role: "user", content: [{ type: "input_text", text: "Generate a concise title for this task." }] },
      { type: "message", id: "msg_permissions", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Network access is restricted. Approval policy is currently never.</permissions instructions>" }] },
    ] as Record<string, unknown>[],
    text: { format: { type: "json_schema", name: "codex_output_schema", strict: true, schema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 36 } }, required: ["title"], additionalProperties: false } } },
  };
}

test("native system context retains all additional tools without inventing or persisting filesystem authority", () => {
  const raw = body(), parsed = parseRequest(raw);
  expect(parsed.context.tools).toHaveLength(9);
  expect(extractChatGptNativeToolContext(parsed)).toEqual({ nativeToolsOnly: true, tools: parsed.context.tools! });
  const store = new ChatGptThreadEnvironmentStore(join(root, "authority.json"), Date.now, root);
  expect(() => store.resolve(parsed)).toThrow("missing cwd");
  const ordinary = body();
  ordinary.client_metadata["x-codex-turn-metadata"] = { ...raw.client_metadata["x-codex-turn-metadata"], thread_source: "user" };
  expect(() => store.resolve(parseRequest(ordinary))).toThrow("missing cwd");
});

test("native-only admission rejects unknown tools, filesystem claims and unrelated or conflicting native identity", () => {
  const mutations: Array<(raw: ReturnType<typeof body>) => void> = [
    raw => { raw.client_metadata["x-codex-turn-metadata"].thread_source = "user"; },
    raw => { raw.client_metadata["x-codex-turn-metadata"].parent_thread_id = "parent"; },
    raw => { raw.client_metadata["x-codex-turn-metadata"].agent_name = "/root/child"; },
    raw => { raw.client_metadata["x-codex-turn-metadata"].workspaces = { "/workspace": {} }; },
    raw => { raw.client_metadata["x-codex-turn-metadata"].sandbox_mode = "workspace-write"; },
    raw => { delete raw.client_metadata["x-codex-turn-metadata"].turn_id; },
    raw => { raw.input[0]!.tools = [fn("exec_command")]; },
    raw => { raw.input[0]!.tools = [{ ...fn("exec"), type: "custom", format: { type: "text" } }]; },
    raw => { raw.input[0]!.tools = [{ type: "namespace", name: "collaboration", tools: [fn("unknown")] }]; },
    raw => { raw.input[1]!.content = [{ type: "input_text", text: "<environment_context><cwd></cwd><filesystem /></environment_context>" }]; },
  ];
  for (const mutate of mutations) {
    const raw = body(); mutate(raw);
    expect(extractChatGptNativeToolContext(parseRequest(raw)), JSON.stringify(raw)).toBeUndefined();
  }
  const conflict = body();
  conflict.input[2]!.internal_chat_message_metadata_passthrough = { turn_id: "another-turn" };
  expect(() => extractChatGptNativeToolContext(parseRequest(conflict))).toThrow("conflicts");
});

test("native-only broker and MCP forward declared tools and reject filesystem calls and authority upgrades", async () => {
  const socketPath = join(root, "broker.sock"), broker = TurnBroker.forSocket(socketPath), remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  const environment = extractChatGptNativeToolContext(parseRequest(body()))!;
  const token = await remote.register(environment);
  const client = new Client({ name: "native-only-regression", version: "1" });
  try {
    const claim = await callTurnBroker<{ bindingId: string; environment: unknown }>(socketPath, { method: "claim", token });
    expect(claim.environment).toEqual(environment);
    await expect(callTurnBroker(socketPath, { method: "invoke", bindingId: claim.bindingId, wireName: "exec_command", arguments: { cmd: "pwd" } })).rejects.toThrow("not declared");
    await expect(remote.updateEnvironment(token, { cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: environment.tools })).rejects.toThrow("changed");
    await expect(remote.updateEnvironment(token, { ...environment, tools: [{ name: "exec", description: "Injected", parameters: {}, freeform: true }] })).rejects.toThrow("invalid");
    await expect(remote.register({ ...environment, cwd: root } as unknown as ChatGptTurnToolContext)).rejects.toThrow("invalid");
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socketPath], cwd: process.cwd(), stderr: "pipe" }));
    const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: { turn_token: token } });
    expect(JSON.stringify(inventory)).toContain("collaboration__spawn_agent");
    for (const [name, args] of [["codex_exec", { cmd: "pwd" }], ["codex_apply_patch", { patch: "*** Begin Patch\n*** End Patch" }], ["codex_view_image", { path: "/tmp/image.png" }]] as const) {
      expect((await client.callTool({ name, arguments: { turn_token: token, ...args } })).isError).toBeTrue();
    }
    const invoke = client.callTool({ name: "codex_tool_call", arguments: { turn_token: token, wire_name: "clock__curr_time", arguments: {} } });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "clock__curr_time", freeform: false });
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "Synthetic native result" }] });
    expect((await invoke).content).toEqual([{ type: "text", text: "Synthetic native result" }]);
  } finally {
    await client.close(); broker.revoke(token); await broker.close();
  }
}, 15000);

test("adapter accepts a structured native system title while ordinary cwd-less tool requests still fail before browser entry", async () => {
  const socketPath = join(root, "adapter.sock");
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: "browser://native-tool-context-regression", chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: false } };
  const worker = ChatGptBrowserWorker.forProvider(provider), original = worker.run;
  let starts = 0;
  worker.run = async (turn: BrowserTurn) => {
    starts++;
    const prepared = await turn.prepare();
    const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeString();
    const claim = await callTurnBroker<{ environment: unknown }>(socketPath, { method: "claim", token });
    expect(claim.environment).toMatchObject({ nativeToolsOnly: true, tools: expect.arrayContaining([expect.objectContaining({ namespace: "collaboration", name: "spawn_agent" })]) });
    expect(claim.environment).not.toHaveProperty("cwd");
    const answer = JSON.stringify({ title: "Synthetic native title" });
    turn.onTextDelta(answer); return answer;
  };
  try {
    const adapter = createChatGptWebAdapter(provider), events: AdapterEvent[] = [];
    await adapter.runTurn!(parseRequest(body()), { headers: new Headers() }, event => events.push(event));
    expect(starts).toBe(1);
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: "done", endTurn: true });
    const ordinary = body(); ordinary.client_metadata["x-codex-turn-metadata"].thread_source = "user";
    const errors: AdapterEvent[] = [];
    await expect(adapter.runTurn!(parseRequest(ordinary), { headers: new Headers() }, event => errors.push(event))).rejects.toMatchObject({ code: "trusted_codex_environment_missing" });
    expect(starts).toBe(1);
  } finally {
    worker.run = original; await TurnBroker.forSocket(socketPath).close();
  }
});
