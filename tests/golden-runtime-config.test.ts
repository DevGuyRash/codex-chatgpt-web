import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { loadConfig, saveConfig } from "../src/config";
import { mcpCommand } from "../src/tunnel";
import { goldenNativeConfig, prepareGoldenRuntimeConfig } from "../scripts/golden/runtime-config";
import { withGoldenRuntime } from "../scripts/golden/runtime";
import { ownedProcessIdentity } from "../scripts/golden/workspace";
import type { GoldenWorkspace } from "../scripts/golden/workspace";

test("full golden configuration and lifecycle retain isolated MCP authority and settle failures", async () => {
  // A nested checkout must not consume the socket budget; installed commands reject OS temp paths.
  const scratch = join(homedir(), ".cache", "cgw-tests"); mkdirSync(scratch, { recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch, "grt-"))), runtimeHome = join(root, "runtime");
  const originalHome = process.env.CODEX_CHATGPT_WEB_HOME, originalCampaign = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  mkdirSync(runtimeHome);
  const workspace: GoldenWorkspace = { version: 1, root, runtimeHome, campaignId: "11111111-1111-4111-8111-111111111111", display: ":1999", viewerUrl: "", codexHome: join(root, "codex"), launcherData: join(root, "launcher"), descriptorPath: join(runtimeHome, "launcher.json"), processes: {} };
  const tunnelBinary = join(root, "tunnel-client"), runtimeKeyFile = join(root, "fixture.key");
  for (const path of [workspace.descriptorPath, tunnelBinary, runtimeKeyFile]) writeFileSync(path, "synthetic", { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_HOME = runtimeHome;
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = workspace.campaignId;
  mkdirSync(workspace.codexHome);
  const originalCodexHome = process.env.CODEX_HOME, originalSqliteHome = process.env.CODEX_SQLITE_HOME;
  const input = { workspace, nativeHome: workspace.codexHome, protocol: "native" as const, connectorName: "Isolated Golden Connector", tunnelId: `tunnel_${"a".repeat(32)}`, tunnelBinary, runtimeKeyFile, capabilities: { solAvailable: true, proAvailable: true } };
  const launcher = spawn("/usr/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  let diagnosticServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { launcher.once("spawn", resolve); launcher.once("error", reject); });
    workspace.processes.launcher = ownedProcessIdentity(launcher.pid!)!;
    const config = prepareGoldenRuntimeConfig(input);
    // A bound server supplies the actual port before the configuration is persisted.
    config.port = 18765;
    saveConfig(config);
    const loaded = loadConfig(runtimeHome);
    expect(loaded).toMatchObject({ mode: "full", subagentProtocol: "native", appName: input.connectorName, browserHost: "launcher", port: 18765, zeroRiskProEnabled: false });
    expect(loaded.brokerSocketPath.startsWith(runtimeHome)).toBe(true);
    expect(loaded.tunnel?.profileDir.startsWith(runtimeHome)).toBe(true);
    expect(loaded.tunnel?.alias).toMatch(/^golden-/);
    expect(mcpCommand(loaded)).toContain(`--home ${runtimeHome}`);
    expect(mcpCommand(loaded)).toContain(`--broker-socket ${loaded.brokerSocketPath}`);
    expect(readFileSync(runtimeKeyFile, "utf8")).toBe("synthetic");
    let mcpFailure = false;
    diagnosticServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ events: mcpFailure ? [{ time: new Date().toISOString(), message: "dispatcher received MCP upstream error; posted error response to control plane", attrs: { failure_source: "client_internal", status_code: 502, upstream_response_received: false, rpc_method: "initialize" } }] : [] }) });
    const calls = join(root, "tunnel-calls.jsonl"), state = join(root, "tunnel-state");
    const healthFile = join(root, "health.url");
    mkdirSync(loaded.tunnel!.profileDir, { recursive: true });
    writeFileSync(healthFile, `http://127.0.0.1:${diagnosticServer.port}/\n`);
    writeFileSync(join(loaded.tunnel!.profileDir, `${loaded.tunnel!.profileName}.yaml`), Bun.YAML.stringify({ control_plane: { tunnel_id: loaded.tunnel!.tunnelId }, health: { url_file: healthFile } }));
    writeFileSync(tunnelBinary, `#!${process.execPath}\nimport { appendFileSync, existsSync, writeFileSync, rmSync } from "node:fs";\nconst action = process.argv[3], state = ${JSON.stringify(state)};\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify({ action }) + "\\n");\nif (action === "connect") { writeFileSync(state, "ready"); console.log(JSON.stringify({ running: true, healthy: true, ready: true })); }\nelse if (action === "stop") { if (existsSync(state + ".fail-stop")) { console.error("synthetic stop failure"); process.exit(1); } rmSync(state, { force: true }); console.log("{}"); }\nelse if (action === "cleanup") console.log(JSON.stringify({ entries: existsSync(state) ? [{ alias: ${JSON.stringify(loaded.tunnel!.alias)}, runtime_state: "ready", classification: "live_runtime", live_runtime: { found: false } }] : [] }));\nelse if (existsSync(state)) console.log(JSON.stringify({ process_running: true, healthy: true, ready: true, health_url: "http://127.0.0.1:${diagnosticServer.port}" }));\nelse { console.error("unknown alias"); process.exit(1); }\n`, { mode: 0o700 });
    chmodSync(tunnelBinary, 0o700);
    const signal = new AbortController().signal;
    const observed = await withGoldenRuntime(input, signal, async runtime => {
      expect(process.env.CODEX_HOME).toBe(workspace.codexHome);
      expect(process.env.CODEX_SQLITE_HOME).toBeUndefined();
      expect(existsSync(runtime.brokerSocketPath)).toBe(true);
      expect(existsSync(state)).toBe(true);
      await expect(withGoldenRuntime(input, signal, async () => {})).rejects.toThrow("already owns");
      return runtime.port;
    });
    expect(observed).toBeGreaterThan(0);
    expect(process.env.CODEX_HOME).toBe(originalCodexHome);
    expect(process.env.CODEX_SQLITE_HOME).toBe(originalSqliteHome);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(loaded.brokerSocketPath)).toBe(false);
    const primary = new Error("synthetic scenario failure");
    await expect(withGoldenRuntime(input, signal, async () => { throw primary; })).rejects.toBe(primary);
    expect(existsSync(state)).toBe(false);
    writeFileSync(state, "external existing runtime");
    const before = readFileSync(calls, "utf8");
    await expect(withGoldenRuntime(input, signal, async () => {})).rejects.toThrow("reconciliation");
    expect(readFileSync(calls, "utf8").slice(before.length).trim()).toBe('{"action":"status"}');
    rmSync(state);
    expect(readFileSync(calls, "utf8").split("\n").filter(line => line === '{"action":"stop"}')).toHaveLength(2);
    mcpFailure = true;
    let executed = false;
    await expect(withGoldenRuntime(input, signal, async () => { executed = true; })).rejects.toThrow("MCP transport is unhealthy");
    expect(executed).toBe(false);
    expect(existsSync(state)).toBe(false);
    mcpFailure = false;
    writeFileSync(state + ".fail-stop", "fixture");
    const cleanupFailure = await withGoldenRuntime(input, signal, async () => { throw primary; }).catch(error => error);
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(cleanupFailure.cause).toBe(primary);
    expect(cleanupFailure.errors[0]).toBe(primary);
    expect(cleanupFailure.errors[1].message).toContain("synthetic stop failure");
    expect(process.env.CODEX_HOME).toBe(originalCodexHome);
    expect(process.env.CODEX_SQLITE_HOME).toBe(originalSqliteHome);
    expect(existsSync(loaded.brokerSocketPath)).toBe(false);
    rmSync(state); rmSync(state + ".fail-stop");
    await expect(withGoldenRuntime(input, signal, async () => {})).rejects.toThrow("already owns");
    expect(() => prepareGoldenRuntimeConfig({ ...input, connectorName: "Codex Native2" })).toThrow("dedicated connector");
    const alias = join(root, "aliased.key"); symlinkSync(runtimeKeyFile, alias);
    expect(() => prepareGoldenRuntimeConfig({ ...input, runtimeKeyFile: alias })).toThrow("canonical regular");
    process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = "different";
    expect(() => prepareGoldenRuntimeConfig(input)).toThrow("campaign identity");
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    expect(() => prepareGoldenRuntimeConfig(input)).toThrow("own canonical home");
  } finally {
    await diagnosticServer?.stop(true);
    if (launcher.pid && launcher.exitCode === null && launcher.signalCode === null) {
      const exited = new Promise<void>(resolve => launcher.once("exit", () => resolve()));
      launcher.kill(); await exited;
    }
    if (originalHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = originalHome;
    if (originalCampaign === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = originalCampaign;
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("golden native provider has no account authentication or uncertain request retries", () => {
  const config = Bun.TOML.parse(goldenNativeConfig({ catalogPath: "/scratch/catalog.json", port: 17842 })) as { model_providers: { golden: Record<string, unknown> } };
  expect(config.model_providers.golden).toMatchObject({ base_url: "http://127.0.0.1:17842/v1", requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0 });
  expect(() => goldenNativeConfig({ catalogPath: "/scratch/catalog.json", port: 0 })).toThrow("bound loopback port");
});

test("live native profiles install the production interrupt hook and selected compatibility features", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-config-")), nativeConfigPath = join(root, "config.toml"), runtimeHome = join(root, "runtime");
  mkdirSync(runtimeHome);
  try {
    for (const protocol of ["native", "compatibility-v1"] as const) {
      const config = Bun.TOML.parse(goldenNativeConfig({ catalogPath: join(root, "catalog.json"), port: 17842, integration: { nativeConfigPath, runtimeHome, protocol } })) as { hooks: { Interrupt: { hooks: { command: string; timeout: number }[] }[]; state: Record<string, { trusted_hash: string }> }; features?: Record<string, boolean>; agents?: { max_depth: number } };
      const hooks = config.hooks.Interrupt.flatMap(group => group.hooks);
      expect(hooks).toHaveLength(1);
      expect(hooks[0]!.command.match(/--home/g)).toHaveLength(1);
      expect(hooks[0]!.command).toContain(runtimeHome);
      expect(hooks[0]!.command).toContain("'hook' 'interrupt'");
      expect(Object.values(config.hooks.state)[0]!.trusted_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      if (protocol === "compatibility-v1") {
        expect(config.features).toMatchObject({ multi_agent: true, multi_agent_v2: false });
        expect(config.agents!.max_depth).toBeGreaterThan(1);
      } else expect(config.features).toBeUndefined();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
