import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, type TunnelConfig } from "../src/config";
import { tunnelHealthLocator } from "../src/tunnel-health";
import { problemFor } from "../src/diagnostics/problems";

const { RuntimeSupervisor } = createRequire(import.meta.url)("../launcher/electron/runtime-supervisor.cjs");
const { createLogger } = createRequire(import.meta.url)("../launcher/electron/generated/diagnostics.cjs");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-health-"));
  const tunnel: TunnelConfig = { binaryPath: join(root, "unused-client"), runtimeKeyFile: join(root, "never-read.key"), tunnelId: `tunnel_${"a".repeat(32)}`, profileDir: join(root, "profiles"), profileName: "owned", alias: "owned" };
  mkdirSync(tunnel.profileDir);
  const urlFile = join(root, "health.url"), profileFile = join(tunnel.profileDir, "owned.yaml");
  const profile = { control_plane: { tunnel_id: tunnel.tunnelId, api_key: `file:${tunnel.runtimeKeyFile}` }, health: { url_file: urlFile, listen_addr: "127.0.0.1:0" } };
  writeFileSync(profileFile, Bun.YAML.stringify(profile));
  writeFileSync(urlFile, "http://127.0.0.1:43127/\n");
  return { root, tunnel, profile, profileFile, urlFile };
}

test("native profile locator uses its configured health file without reading runtime credentials", () => {
  const f = fixture();
  try {
    expect(tunnelHealthLocator(f.tunnel)).toEqual({ baseUrl: "http://127.0.0.1:43127" });
    writeFileSync(f.urlFile, "http://[::1]:43128/\n");
    expect(tunnelHealthLocator(f.tunnel)).toEqual({ baseUrl: "http://[::1]:43128" });
    f.profile.control_plane.tunnel_id = `tunnel_${"b".repeat(32)}`;
    writeFileSync(f.profileFile, Bun.YAML.stringify(f.profile));
    expect(() => tunnelHealthLocator(f.tunnel)).toThrow("does not identify");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("standalone health-locator exits from its local read without starting a diagnostics writer", () => {
  const f = fixture();
  try {
    const config = { ...defaultConfig("full", f.root), tunnel: f.tunnel, automaticTunnel: f.tunnel };
    writeFileSync(join(f.root, "config.json"), JSON.stringify(config));
    const result = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), "--home", f.root, "tunnel", "health-locator"], { stdout: "pipe", stderr: "pipe" });
    expect({ code: result.exitCode, output: result.stdout.toString().trim() }).toEqual({ code: 0, output: JSON.stringify({ baseUrl: "http://127.0.0.1:43127" }) });
    expect(existsSync(join(f.root, "diagnostics", "observability", "diagnostics.sqlite"))).toBeFalse();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("native profile locator rejects remote, credentialed, ambiguous and oversized inputs without reflecting private source", () => {
  const f = fixture();
  try {
    for (const value of ["https://example.com:443", "http://localhost:43127", "http://127.0.0.1", "http://127.0.0.1:43127/api/logs", "http://SYNTHETIC_PRIVATE:secret@127.0.0.1:43127", "http://127.0.0.1:43127/?secret=SYNTHETIC_PRIVATE", "http://127.0.0.1:43127/#SYNTHETIC_PRIVATE", "SYNTHETIC_PRIVATE", "x".repeat(4097)]) {
      writeFileSync(f.urlFile, value);
      let problem;
      try { tunnelHealthLocator(f.tunnel); } catch (error) { problem = problemFor(error); }
      expect(problem?.code).toMatch(/^tunnel_health_(endpoint|locator)_(invalid|unavailable)$/);
      expect(JSON.stringify(problem)).not.toContain("SYNTHETIC_PRIVATE");
    }
    writeFileSync(f.profileFile, "health: [SYNTHETIC_PRIVATE\n");
    let problem;
    try { tunnelHealthLocator(f.tunnel); } catch (error) { problem = problemFor(error); }
    expect(problem?.code).toBe("tunnel_health_profile_invalid");
    expect(JSON.stringify(problem)).not.toContain("SYNTHETIC_PRIVATE");
    writeFileSync(f.profileFile, "x".repeat(1024 * 1024 + 1));
    expect(() => tunnelHealthLocator(f.tunnel)).toThrow("bounded regular file");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("supervisor falls back from ready inventory without an admin URL through the real locator CLI and preserves its typed failures", async () => {
  const f = fixture();
  const config = { ...defaultConfig("full", f.root), tunnel: f.tunnel, automaticTunnel: f.tunnel };
  writeFileSync(join(f.root, "config.json"), JSON.stringify(config));
  const commands: string[][] = [];
  const supervisor = new RuntimeSupervisor({ coreHome: f.root,
    runtimeInvocationFactory: ({ args }: { args: string[] }) => { commands.push(args); return { executable: process.execPath, args: [resolve("src/cli.ts"), ...args], cwd: resolve(".") }; },
  });
  supervisor.runTunnelCommand = async (_config: unknown, args: string[]) => {
    expect(args).toEqual(["runtimes", "cleanup", "--json"]);
    return { code: 0, output: JSON.stringify({ entries: [{ alias: f.tunnel.alias, runtime_state: "ready", classification: "live_runtime", live_runtime: { found: false } }] }) };
  };
  try {
    expect(await supervisor.discoverTunnelHealthBaseUrl(config)).toBe("http://127.0.0.1:43127");
    expect(commands).toEqual([["--home", f.root, "tunnel", "health-locator"]]);
    writeFileSync(f.profileFile, "health: [SYNTHETIC_PRIVATE\n");
    const failure = await supervisor.discoverTunnelHealthBaseUrl(config).catch((error: unknown) => error);
    expect(problemFor(failure)).toMatchObject({ code: "tunnel_health_profile_invalid", origin: "tunnel-profile", stage: "tunnel.health_discovery", exitCode: 1 });
    expect(supervisor.tunnelHealthBaseUrl).toBeNull();
    expect(JSON.stringify(problemFor(failure))).not.toContain("SYNTHETIC_PRIVATE");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
}, 15000);

test("launcher locator CLI uses the production child collection channel with correlated typed evidence", async () => {
  const f = fixture();
  const config = { ...defaultConfig("full", f.root), tunnel: f.tunnel, automaticTunnel: f.tunnel };
  writeFileSync(join(f.root, "config.json"), JSON.stringify(config));
  const invocation = { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", f.root, "diagnostics", "worker"] };
  const logger = createLogger({ filePath: join(f.root, "launcher.log"), invocation, target: "fixture", environment: "test" });
  const parent = logger.diagnostics.begin("runtime.start", {}, null);
  const supervisor = new RuntimeSupervisor({ coreHome: f.root, logger,
    runtimeInvocationFactory: ({ args }: { args: string[] }) => ({ executable: process.execPath, args: [resolve("src/cli.ts"), ...args], cwd: resolve(".") }),
  });
  supervisor.runTunnelCommand = async () => ({ code: 0, output: JSON.stringify({ entries: [{ alias: f.tunnel.alias, runtime_state: "ready", live_runtime: { found: false } }] }) });
  try {
    await logger.ready;
    f.profile.control_plane.tunnel_id = "SYNTHETIC_PRIVATE_WRONG_ID";
    writeFileSync(f.profileFile, Bun.YAML.stringify(f.profile));
    const failure = await parent.run(() => supervisor.discoverTunnelHealthBaseUrl(config)).catch((error: unknown) => error);
    expect(problemFor(failure)).toMatchObject({ code: "tunnel_health_identity_mismatch", traceId: parent.context.traceId, origin: "tunnel-profile", exitCode: 1 });
    parent.end("failed"); await logger.diagnostics.close(); await logger.client.flush();
    const query = await logger.client.query({ view: "events", traceId: parent.context.traceId, limit: 200 });
    const control = query.events.find((event: any) => event.name === "tunnel.control" && event.span?.endTime);
    const cli = query.events.find((event: any) => event.name === "cli.tunnel" && event.span?.endTime);
    expect(control).toMatchObject({ parentSpanId: parent.context.spanId, attributes: { action: "health-locator", exitCode: 1, exitObserved: true, outputDrained: true }, span: { outcome: "failed" } });
    expect(cli).toMatchObject({ parentSpanId: control?.spanId, span: { outcome: "failed" } });
    expect(query.events.some((event: any) => event.spanId === cli?.spanId && event.problem?.code === "tunnel_health_identity_mismatch")).toBeTrue();
    expect(JSON.stringify(query.events)).not.toContain("SYNTHETIC_PRIVATE");
  } finally { await logger.close(); rmSync(f.root, { recursive: true, force: true }); }
}, 15000);
