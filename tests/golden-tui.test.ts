import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenTui } from "../scripts/golden/tui";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { ownedProcessIdentity, type OwnedProcess } from "../scripts/golden/workspace";
import { NativeRpc } from "../scripts/golden/native-protocol";
import { extractCodexTurnIdentityFromBody } from "../src/adapters/chatgpt-web/environment";

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY || !Bun.which("tmux"))("private native TUI renders a proposed plan and runs the subsequent execution turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-tui-")), home = join(root, "codex");
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize native TUI fixture repository");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!; let requests = 0, titleRequests = 0, lastSnapshot = "", stderr = "";
  const efforts: unknown[] = [];
  const nativeRequests: { title: boolean; identity: ReturnType<typeof extractCodexTurnIdentityFromBody> }[] = [];
  const nativeFrames: { direction: string; message: Record<string, any> }[] = [];
  let identities: OwnedProcess[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/responses") return new Response("fixture endpoint only", { status: 404 });
    const body = await request.json() as { reasoning?: { effort?: string }; input?: Array<{ role?: string; content?: Array<{ text?: string }> }> };
    const lastUser = body.input?.filter(item => item.role === "user").at(-1)?.content?.map(part => part.text ?? "").join("") ?? "";
    const title = lastUser.startsWith("Generate a concise, single-line task title of at most 36 characters");
    nativeRequests.push({ title, identity: extractCodexTurnIdentityFromBody(body) });
    if (title) titleRequests++; else efforts.push(body.reasoning?.effort);
    const number = title ? 0 : ++requests;
    async function* output(): AsyncIterable<AdapterEvent> {
      yield { type: "text_delta", text: title ? JSON.stringify({ title: "Reconcile synthetic orders" }) : number === 1 ? "<proposed_plan>\n# Synthetic TUI plan\nReconcile the orders and verify the independent totals.\n</proposed_plan>" : "Synthetic TUI execution complete.", phase: "final_answer" };
      yield { type: "done", endTurn: true };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `model_provider = "golden_fixture"\nmodel = "${route.slug}"\nmodel_reasoning_effort = "low"\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n[model_providers.golden_fixture]\nname = "Loopback synthetic fixture"\nbase_url = "http://127.0.0.1:${server.port}"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  let tui: GoldenTui | undefined;
  let observer: NativeRpc | undefined;
  try {
    tui = await GoldenTui.start({ root: join(root, "terminal"), cwd: root, nativeExecutable: process.env.CODEX_TEST_PROFILE_BINARY!, tmuxExecutable: Bun.which("tmux")!, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, route, modelProvider: "golden_fixture",
      onSnapshot: text => { lastSnapshot = text; }, onInput: () => {}, onLaunch: value => { identities = Object.values(value); }, onTransport: (_stream, text) => { stderr = (stderr + text).slice(-8192); } });
    await tui.waitForReady({ timeoutMs: 10000 });
    const endpoint = tui.controlIdentity();
    expect(() => new NativeRpc({ socket: { ...endpoint, inode: endpoint.inode + 1 }, onFrame: () => {} })).toThrow("ownership changed");
    observer = new NativeRpc({ socket: endpoint, onFrame: frame => { nativeFrames.push(frame); } });
    await observer.request("initialize", { clientInfo: { name: "golden_tui_observer", version: "1" }, capabilities: { experimentalApi: true } });
    await observer.notify("initialized");
    await tui.submit("/plan");
    await tui.waitForView(text => text.includes("Plan mode") && !text.includes("switch to Plan mode"), { timeoutMs: 10000 });
    await tui.submit("Plan the synthetic reconciliation task.");
    const plan = await tui.waitForView(text => text.includes("Synthetic TUI plan"), { timeoutMs: 10000 });
    expect(plan).toContain("Reconcile the orders");
    const decision = await tui.waitForView(text => text.includes("Implement this plan"), { timeoutMs: 5000 });
    expect(decision).toContain("› 1. Yes, implement this plan");
    tui.key("Enter");
    const executed = await tui.waitForView(text => text.includes("Synthetic TUI execution complete."), { timeoutMs: 10000 });
    expect(executed).toContain("Synthetic TUI execution complete.");
    expect(requests).toBe(2);
    expect(titleRequests).toBe(1);
    expect(efforts).toEqual([route.codexEffort, route.codexEffort]);
    const primary = nativeRequests.find(request => !request.title)!.identity.threadId!;
    const title = nativeRequests.find(request => request.title)!.identity.threadId!;
    expect(title).not.toBe(primary);
    const read = await observer.request("thread/read", { threadId: primary, includeTurns: true }) as { thread: { id: string; turns: { status: string; items: { type: string }[] }[] } };
    expect(read.thread.id).toBe(primary);
    expect(read.thread.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
    expect(read.thread.turns[0]!.items.some(item => item.type === "plan")).toBeTrue();
    expect(nativeFrames.some(frame => frame.message.method === "thread/started" && frame.message.params.thread.id === title && frame.message.params.thread.ephemeral)).toBeTrue();
    expect(nativeFrames.some(frame => frame.message.method === "thread/status/changed" && frame.message.params.threadId === title && frame.message.params.status.type === "idle")).toBeTrue();
    await observer.close(100);
    expect(ownedProcessIdentity(endpoint.owner.pid)?.start).toBe(endpoint.owner.start);
  } catch (error) {
    if (tui) try { lastSnapshot = await tui.snapshot(); } catch { /* Preserve the last available owned snapshot. */ }
    throw new Error(`${String(error)}\n${lastSnapshot}\n${stderr}`);
  } finally {
    try { await observer?.close(100); } finally { try { await tui?.close(); } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); } }
    expect(identities.every(identity => ownedProcessIdentity(identity.pid)?.start !== identity.start)).toBe(true);
  }
}, 40000);
