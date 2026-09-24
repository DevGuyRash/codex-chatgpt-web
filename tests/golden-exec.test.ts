import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeExecArgs, runNativeExec } from "../scripts/golden/exec";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { goldenNativeConfig, goldenNativeEnvironment } from "../scripts/golden/runtime-config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { defaultConfig } from "../src/config";
import { GoldenAppServer, initializeGoldenNativeHome } from "../scripts/golden/app-server";
import { runNativeScenario } from "../scripts/golden/native-scenarios";
import { createWorkload } from "../scripts/golden/workloads";

test("native exec requires terminal protocol evidence as well as process exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-exec-")), executable = join(root, "peer");
  writeFileSync(executable, `#!${process.execPath}
let input="";const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");
process.stdin.on("data",chunk=>input+=chunk.toString());
process.stdin.on("end",()=>{
 send({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"});send({type:"turn.started"});
 if(input==="wait") {setInterval(()=>{},1000);return;}
 if(input!=="missing")send({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}});
});
`, { mode: 0o700 });
  const inputs: string[] = [];
  const run = (prompt: string, timeoutMs = 2000) => runNativeExec({ executable, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, prompt, timeoutMs,
    onInput: value => { inputs.push(value); }, onLaunch: () => {}, onEvent: () => {}, onStderr: () => {} });
  try {
    expect(await run("東京")).toMatchObject({ status: "completed", exit: { code: 0, signal: null } });
    await expect(run("missing")).rejects.toMatchObject({ code: "native_completion_missing", uncertain: true });
    await expect(run("wait", 100)).rejects.toMatchObject({ code: "native_event_timeout", uncertain: true });
    expect(inputs).toEqual(["東京", "missing", "wait"]);
    const prompts: string[] = [];
    if (spawnSync("git", ["-C", root, "init", "-q"]).status !== 0) throw new Error("Could not initialize the format scenario fixture repository");
    const scenario = { executable, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, variant: "formats", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async (category: string, text: string) => { if (category === "prompt") prompts.push(text); }, checkpoint: () => {} };
    await expect(runNativeScenario({ ...scenario, workload: createWorkload({ level: 1, seed: "formats", batch: 0 }) })).rejects.toThrow("full shared fixture set");
    const workload = createWorkload({ level: 1, seed: "formats", batch: 0, formatCoverage: "all" });
    expect(await runNativeScenario({ ...scenario, workload })).toMatchObject({ status: "completed", variant: "formats" });
    expect(prompts).toEqual([workload.prompt]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("buffered exec events share receipt time despite slow capture callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-exec-receipt-")), executable = join(root, "peer");
  writeFileSync(executable, `#!${process.execPath}
process.stdin.on("end", () => process.stdout.write([
  {type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"},
  {type:"turn.started"},
  {type:"item.completed",item:{type:"command_execution",id:"one"}},
  {type:"item.completed",item:{type:"command_execution",id:"two"}},
  {type:"turn.completed"},
].map(value => JSON.stringify(value)).join("\\n") + "\\n"));
process.stdin.resume();
`, { mode: 0o700 });
  const times: number[] = [];
  try {
    const result = await runNativeExec({ executable, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, prompt: "Inspect", timeoutMs: 2000,
      onInput: () => {}, onLaunch: () => {}, onStderr: () => {},
      onEvent: async (event, receivedAtMs) => {
        if (event.type !== "item.completed") return;
        times.push(receivedAtMs);
        await Bun.sleep(30);
      },
    });
    expect(result.status).toBe("completed");
    expect(times).toHaveLength(2);
    expect(times[1]).toBe(times[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exec resume pins its captured thread, effort and sandbox without shell interpolation", () => {
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!;
  const args = nativeExecArgs({ route, resumeId: "11111111-1111-7111-8111-111111111111", images: ["/scratch/image with space.png"] });
  expect(args.slice(-5)).toEqual(["resume", "11111111-1111-7111-8111-111111111111", "--image", "/scratch/image with space.png", "-"]);
  expect(args).toContain("workspace-write");
  expect(() => nativeExecArgs({ route, resumeId: "--last" })).toThrow("exact captured");
  expect(() => nativeExecArgs({ route: CHATGPT_WEB_MODEL_ROUTES.find(route => route.adapterEffort === "max")! })).toThrow("non-Pro");
});

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("installed native exec consumes the production bridge through a local synthetic provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-exec-native-")), home = join(root, "codex");
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize disposable native fixture repository");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!; let requests = 0, stderr = "";
  const events: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/responses") return new Response("fixture endpoint only", { status: 404 });
    await request.arrayBuffer(); requests++;
    async function* output(): AsyncIterable<AdapterEvent> {
      yield { type: "text_delta", text: "Synthetic native consumer verification.", phase: "final_answer" };
      yield { type: "done", endTurn: true, usage: { inputTokens: 12, outputTokens: 6 } };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `[model_providers.golden_fixture]\nname = "Loopback synthetic fixture"\nbase_url = "http://127.0.0.1:${server.port}"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  try {
    const result = await runNativeExec({ executable: process.env.CODEX_TEST_PROFILE_BINARY!, cwd: root,
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, route, modelProvider: "golden_fixture", prompt: "Return the synthetic fixture response.", timeoutMs: 15000,
      onInput: () => {}, onLaunch: () => {}, onEvent: event => { events.push(event.type); }, onStderr: text => { stderr = (stderr + text).slice(-8192); },
    }).catch(error => { throw new Error(`${error.message}: ${stderr}`); });
    expect(result.status).toBe("completed");
    expect(requests).toBe(1);
    expect(events).toContain("item.completed");
    const resumed = await runNativeExec({ executable: process.env.CODEX_TEST_PROFILE_BINARY!, cwd: root,
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, route, modelProvider: "golden_fixture", resumeId: result.threadId, prompt: "Continue the same synthetic fixture task.", timeoutMs: 15000,
      onInput: () => {}, onLaunch: () => {}, onEvent: () => {}, onStderr: text => { stderr = (stderr + text).slice(-8192); },
    }).catch(error => { throw new Error(`${error.message}: ${stderr}`); });
    expect(resumed).toMatchObject({ status: "completed", threadId: result.threadId });
    expect(requests).toBe(2);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY).each(["exec", "app-server", ...(Bun.which("tmux") ? ["tui" as const] : [])] as const)("native golden tools pin per-task Git access with a shared home (%s)", async driver => {
  // Native workspace-write permits the system temp directory independently of this
  // per-task grant, so exercise the same non-temp location as the live workspace.
  const context = resolve("context"); mkdirSync(context, { recursive: true });
  const root = mkdtempSync(join(context, "golden-toolchain-")), home = join(root, "native"), task = join(root, "task"), sibling = join(root, "other");
  mkdirSync(home); mkdirSync(task); mkdirSync(join(sibling, ".git"), { recursive: true });
  const executable = process.env.CODEX_TEST_PROFILE_BINARY!, env = goldenNativeEnvironment(root, home, executable);
  const git = (...args: string[]) => spawnSync("/usr/bin/git", ["-C", task, ...args], { env, encoding: "utf8" });
  git("init", "-q"); git("config", "user.name", "Synthetic Test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!; let requests = 0, returned = "", stderr = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const body = await request.json();
    const lastUser = body.input?.filter((item: { role?: string }) => item.role === "user").at(-1)?.content?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    const title = lastUser.startsWith("Generate a concise, single-line task title of at most 36 characters");
    if (!title) requests++;
    returned += JSON.stringify(Array.isArray(body.input) ? body.input.filter((item: { type?: string }) => item.type === "function_call_output" || item.type === "custom_tool_call_output") : []);
    const first = !title && requests === 1;
    async function* output(): AsyncIterable<AdapterEvent> {
      if (first) {
        yield { type: "tool_call_start", id: "call_toolchain_fixture", name: "exec_command" };
        const otherFile = `'${join(sibling, ".git", "forbidden").replaceAll("'", "'\\''")}'`;
        yield { type: "tool_call_delta", arguments: JSON.stringify({ cmd: `if printf forbidden 2>/dev/null > ${otherFile}; then echo CROSS_TASK_WRITE; else echo SIBLING_DENIED; fi; command -v git && mkdir -p output && printf 'synthetic artifact\\n' > output/result.txt && git add output/result.txt && git commit -m 'Synthetic artifact'`, workdir: task, yield_time_ms: 10000, max_output_tokens: 2000 }) };
        yield { type: "tool_call_end" };
      } else yield { type: "text_delta", text: title ? JSON.stringify({ title: "Synthetic toolchain" }) : "Synthetic toolchain fixture finished.", phase: "final_answer" };
      yield { type: "done", endTurn: !first, usage: { inputTokens: 12, outputTokens: 6 } };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const bundled = spawnSync(executable, ["debug", "models", "--bundled"], { env, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    if (bundled.status !== 0) throw new Error("Native fixture catalog missing");
    const catalogPath = join(root, "models.json");
    writeFileSync(catalogPath, JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), defaultConfig("browser-only", home))));
    writeFileSync(join(home, "config.toml"), goldenNativeConfig({ catalogPath, port: server.port!, artifactRepository: sibling }));
    // Use the campaign's common initialization boundary before testing per-task grants.
    // Cold startup has its own bounded handshake and cannot consume the tool deadline.
    await initializeGoldenNativeHome({ executable, cwd: task, env, route, modelProvider: "golden", signal: new AbortController().signal,
      onLaunch: () => {}, onFrame: () => {}, onStderr: text => { stderr += text; },
    });
    expect(requests).toBe(0);
    if (driver === "exec") {
      const result = await runNativeExec({ executable, cwd: task, env, route, modelProvider: "golden", artifactRepository: task, prompt: "Exercise the synthetic toolchain fixture.", timeoutMs: 15000, onInput: () => {}, onLaunch: () => {}, onEvent: () => {}, onStderr: text => { stderr += text; } });
      expect(result.status).toBe("completed");
    } else if (driver === "tui") {
      const { GoldenTui } = await import("../scripts/golden/tui");
      const terminalRoot = mkdtempSync(join(tmpdir(), "golden-tool-tui-"));
      let tui: Awaited<ReturnType<typeof GoldenTui.start>> | undefined;
      try {
        tui = await GoldenTui.start({ root: terminalRoot, cwd: task, nativeExecutable: executable, tmuxExecutable: Bun.which("tmux")!, env, route, modelProvider: "golden", artifactRepository: task,
          onInput: () => {}, onLaunch: () => {}, onSnapshot: text => { stderr += `\nTerminal snapshot:\n${text}`; }, onTransport: (_stream, text) => { stderr += text; } });
        await tui.waitForReady({ timeoutMs: 10000 });
        await tui.submit("Exercise the synthetic toolchain fixture.");
        await tui.waitForView(text => text.includes("Synthetic toolchain fixture finished."), { timeoutMs: 15000 });
      } finally { try { await tui?.close(); } finally { rmSync(terminalRoot, { recursive: true, force: true }); } }
    } else {
      const app = new GoldenAppServer({ executable, cwd: task, env, route, modelProvider: "golden", artifactRepository: task, onFrame: () => {}, onStderr: text => { stderr += text; } });
      try {
        await app.initialize(); await app.openThread();
        const turn = await app.startTurn({ text: "Exercise the synthetic toolchain fixture." });
        expect((await app.waitForCompletion(turn.id, { timeoutMs: 15000 })).status).toBe("completed");
      } finally { await app.close(); }
    }
    expect(requests).toBe(2);
    expect(returned).toContain("/usr/bin/git");
    expect(returned).not.toContain("dev-auth");
    expect(returned).toContain("SIBLING_DENIED");
    expect(existsSync(join(sibling, ".git", "forbidden"))).toBe(false);
    const head = git("log", "-1", "--format=%s");
    expect(head.stdout.trim(), returned + stderr).toBe("Synthetic artifact");
    expect(git("status", "--porcelain").stdout.trim()).toBe("");
  } catch (error) {
    throw new Error(`Synthetic native ${driver} permission fixture failed after ${requests} provider requests; tool output=${returned}; stderr=${stderr}`, { cause: error });
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
// Let the driver's bounded initialization and completion report their own failure
// and settle the process before the test runner's outer deadline interrupts cleanup.
}, 180000);
