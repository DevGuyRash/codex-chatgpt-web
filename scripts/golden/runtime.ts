import { atomicWriteFile, getConfigPath, saveConfig, type AppConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { connectTunnel, stopTunnel, tunnelStatus, waitForTunnelReady } from "../../src/tunnel";
import { closeChatGptBrowserWorkers } from "../../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../../src/adapters/chatgpt-web/turn-broker";
import { prepareGoldenRuntimeConfig } from "./runtime-config";
import { ownsProcess } from "./workspace";
import { createRequire } from "node:module";
import { assertBorrowedTunnelInactive } from "./borrowed-tunnel";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { containsPath } from "../../src/diagnostics/paths";
import { flushResponseState } from "../../src/responses/state";
import { runtimeDiagnostics } from "../../src/diagnostics/runtime";
import { resolve } from "node:path";

// Reuse the production supervisor's endpoint validation and MCP failure interpretation.
const { RuntimeSupervisor } = createRequire(import.meta.url)("../../launcher/electron/runtime-supervisor.cjs") as {
  RuntimeSupervisor: new (input: { coreHome: string; diagnostics?: ReturnType<typeof runtimeDiagnostics>; runtimeInvocationFactory: (input: { args: string[] }) => { executable: string; args: string[]; cwd: string } }) => {
    waitForTunnelMcpTransport(config: AppConfig): Promise<{ observed: boolean; ok: boolean; fatal: boolean; detail: string }>;
  };
};

let active = false;

/** One dedicated runner process owns the runtime. The callback must settle all its native producers. */
export async function withGoldenRuntime<T>(input: Parameters<typeof prepareGoldenRuntimeConfig>[0] & { nativeHome: string }, signal: AbortSignal, run: (config: AppConfig) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (active) throw new Error("This process already owns a golden runtime");
  const config = prepareGoldenRuntimeConfig(input);
  if (realpathSync(input.nativeHome) !== input.nativeHome || !lstatSync(input.nativeHome).isDirectory() || input.nativeHome === input.workspace.root || !containsPath(input.workspace.root, input.nativeHome)) throw new Error("Golden runtime requires the native producers' canonical isolated home");
  if (!input.workspace.processes.launcher || !ownsProcess(input.workspace.processes.launcher)) throw new Error("Golden runtime requires its owned live launcher");
  const prior = tunnelStatus(config);
  if (prior.processRunning || !(/not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(prior.detail) || prior.state === "stopped")) throw new Error(`The golden tunnel requires reconciliation before startup: ${prior.detail}`);
  active = true;
  const previousCodexHome = process.env.CODEX_HOME, previousSqliteHome = process.env.CODEX_SQLITE_HOME;
  const broker = TurnBroker.forSocket(config.brokerSocketPath);
  let server: ReturnType<typeof startServer> | undefined, tunnelAttempted = false;
  const configPath = getConfigPath(input.workspace.runtimeHome);
  let originalConfig: Buffer | undefined, writtenConfig: Buffer | undefined;
  let result: T | undefined, failed = false, failure: unknown;
  const step = async <V>(name: string, action: () => V | Promise<V>): Promise<V> => {
    const diagnostics = runtimeDiagnostics();
    return diagnostics ? diagnostics.run(`golden.runtime.${name}`, async () => await action()) : await action();
  };
  try {
    process.env.CODEX_HOME = input.nativeHome;
    delete process.env.CODEX_SQLITE_HOME;
    if (existsSync(configPath)) {
      const stat = lstatSync(configPath);
      if (!stat.isFile() || stat.nlink !== 1 || realpathSync(configPath) !== configPath) throw new Error("The isolated runtime configuration is aliased");
      originalConfig = readFileSync(configPath);
    }
    await step("broker_listen", () => broker.listen());
    signal.throwIfAborted();
    server = await step("http_listen", () => startServer(config));
    if (!server.port) throw new Error("Golden runtime did not bind its loopback port");
    config.port = server.port;
    saveConfig(config);
    writtenConfig = readFileSync(configPath);
    if (input.borrowFromRuntimeHome) await assertBorrowedTunnelInactive(input.borrowFromRuntimeHome, input.workspace.root, config);
    tunnelAttempted = true;
    await step("tunnel_connect", () => connectTunnel(config));
    const ready = await step("tunnel_ready", () => waitForTunnelReady(config));
    if (!ready.ok) throw new Error(`Golden tunnel did not become ready: ${ready.detail}`);
    const observation = await step("mcp_health", () => new RuntimeSupervisor({ coreHome: input.workspace.runtimeHome, diagnostics: runtimeDiagnostics(),
      runtimeInvocationFactory: ({ args }) => ({ executable: process.execPath, args: [resolve(import.meta.dir, "../../src/cli.ts"), ...args], cwd: resolve(import.meta.dir, "../..") }),
    }).waitForTunnelMcpTransport(config));
    if (!observation.observed || !observation.ok) throw new Error(`Golden MCP transport was not observed healthy: ${observation.detail}`);
    signal.throwIfAborted();
    result = await run(config);
  } catch (error) { failed = true; failure = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (name: string, action: () => unknown | Promise<unknown>) => { try { await step(name, action); } catch (error) { cleanupErrors.push(error); } };
    // Stop new HTTP admission before releasing the browser and tool boundaries.
    await clean("http_stop", () => server?.stop(true));
    await clean("browser_close", () => closeChatGptBrowserWorkers());
    if (tunnelAttempted) await clean("tunnel_stop", () => stopTunnel(config));
    await clean("broker_close", () => broker.close());
    await clean("state_flush", () => flushResponseState());
    if (writtenConfig && !cleanupErrors.length) await clean("config_restore", () => {
      if (!existsSync(configPath) || !readFileSync(configPath).equals(writtenConfig!)) throw new Error("The isolated runtime configuration changed; restoration requires reconciliation");
      if (originalConfig) atomicWriteFile(configPath, originalConfig); else unlinkSync(configPath);
    });
    // Failed cleanup leaves this process unavailable for another runtime; a new attempt
    // requires external reconciliation, not a second callback over uncertain resources.
    active = cleanupErrors.length > 0;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
    if (cleanupErrors.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "Golden runtime cleanup did not settle", failed ? { cause: failure } : undefined);
  }
  if (failed) throw failure;
  return result as T;
}
