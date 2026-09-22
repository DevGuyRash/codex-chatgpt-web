import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoldenAppServer } from "../scripts/golden/app-server";
import { goldenNativeConfig, goldenNativeEnvironment } from "../scripts/golden/runtime-config";
import { defaultConfig, getConfigPath } from "../src/config";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { bridgeToResponsesSSE } from "../src/bridge";

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("golden native interruption invokes the installed exact-turn runtime hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-interrupt-")), home = join(root, "native"), runtimeHome = join(root, "runtime");
  mkdirSync(home); mkdirSync(runtimeHome);
  const executable = process.env.CODEX_TEST_PROFILE_BINARY!, env = goldenNativeEnvironment(root, home, executable), route = CHATGPT_WEB_MODEL_ROUTES[0]!;
  if (Bun.spawnSync(["/usr/bin/git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize native fixture repository");
  const config = defaultConfig("browser-only", runtimeHome), interruptions: unknown[] = [];
  let admitted!: () => void, release!: () => void;
  const receiving = new Promise<void>(resolve => { admitted = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/admin/interrupt-turn") {
      if (request.headers.get("authorization") !== `Bearer ${config.controlToken}`) return new Response("Unauthorized", { status: 401 });
      interruptions.push(await request.json());
      return Response.json({ status: "ok", cancelled_http_turns: 1, cancelled_browser_turns: 1, cleanup_status: "completed" });
    }
    if (path !== "/v1/responses") return new Response("Fixture endpoint only", { status: 404 });
    await request.arrayBuffer(); admitted();
    async function* output() {
      yield { type: "text_delta" as const, text: "Synthetic work is active.", phase: "commentary" as const };
      await waiting;
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  let stderr = "", app: GoldenAppServer | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    config.port = server.port!;
    writeFileSync(getConfigPath(runtimeHome), JSON.stringify(config), { mode: 0o600 });
    const catalogPath = join(home, "models.json"), nativeConfigPath = join(home, "config.toml");
    const bundled = Bun.spawnSync([executable, "debug", "models", "--bundled"], { env, cwd: root });
    if (bundled.exitCode !== 0) throw new Error("Native fixture catalog is unavailable");
    writeFileSync(catalogPath, JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout.toString()), config)));
    writeFileSync(nativeConfigPath, goldenNativeConfig({ catalogPath, port: server.port!, integration: { nativeConfigPath, runtimeHome, protocol: "native" } }));
    app = new GoldenAppServer({ executable, cwd: root, env, route, modelProvider: "golden", onFrame: () => {}, onStderr: text => { stderr = (stderr + text).slice(-8192); } });
    await app.initialize(); const threadId = await app.openThread();
    const turn = await app.startTurn({ text: "Perform the synthetic local fixture work." });
    await Promise.race([receiving, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Native fixture did not reach its provider: ${stderr}`)), 15000); })]);
    clearTimeout(timer);
    await app.interrupt(turn.id);
    expect((await app.waitForCompletion(turn.id, { timeoutMs: 10000 })).status).toBe("interrupted");
    expect(interruptions).toEqual([{ threadId, turnId: turn.id }]);
  } finally { clearTimeout(timer); release(); try { await app?.close(); } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); } }
}, 120000);
