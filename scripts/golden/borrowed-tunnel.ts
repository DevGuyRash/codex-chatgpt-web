import { existsSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { loadConfig, type AppConfig } from "../../src/config";
import { containsPath } from "../../src/diagnostics/paths";
import { runCommand } from "../../src/process";
import { tunnelStatus } from "../../src/tunnel";
import { DiagnosticError } from "../../src/diagnostics/problems";

const KNOWN_RUNTIME_STATES = new Set(["stopped", "starting", "ready", "stopping", "failed"]);

export function readBorrowedTunnel(home: string, isolatedRoot: string, selected: Pick<AppConfig, "appName" | "tunnel">): AppConfig {
  if (realpathSync(home) !== home || containsPath(isolatedRoot, home)) throw new Error("The borrowed tunnel source must remain outside the isolated workspace");
  const source = loadConfig(home), original = source.tunnel, chosen = selected.tunnel;
  if (source.mode !== "full" || source.browserInteractionMode !== "automatic" || !original || !chosen || source.appName !== selected.appName
    || original.tunnelId !== chosen.tunnelId || original.binaryPath !== chosen.binaryPath || original.runtimeKeyFile !== chosen.runtimeKeyFile) throw new Error("The borrowed tunnel selection differs from its current source configuration");
  return source;
}

function requireClosedPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (error?: Error) => { socket.destroy(); error ? reject(error) : resolve(); };
    socket.setTimeout(2000, () => done(new Error("Source Responses port could not be observed inactive")));
    socket.once("connect", () => done(new Error("The source Responses server is active")));
    socket.once("error", error => done((error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? undefined : new Error("Source Responses port state is unknown", { cause: error })));
  });
}

/** Read-only admission for the user's choice to borrow the existing remote tunnel. */
export async function assertBorrowedTunnelInactive(home: string, isolatedRoot: string, selected: AppConfig): Promise<void> {
  const source = readBorrowedTunnel(home, isolatedRoot, selected);
  if (existsSync(source.brokerSocketPath)) throw new Error("The source broker still exists; its ownership requires reconciliation");
  await requireClosedPort(source.port);
  const original = source.tunnel!;
  const result = runCommand(original.binaryPath, ["runtimes", "list", "--json"], { timeout: 15000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error("Existing tunnel aliases could not be inspected");
  let inventory: unknown;
  try { inventory = JSON.parse(result.stdout); } catch { throw new Error("Existing tunnel aliases did not provide structured evidence"); }
  if (!inventory || typeof inventory !== "object" || !("aliases" in inventory) || !Array.isArray(inventory.aliases)) throw new Error("Existing tunnel alias inventory is unavailable");
  const aliases = new Set([original.alias]);
  for (const entry of inventory.aliases) {
    if (!entry || typeof entry !== "object" || entry.tunnel_id !== original.tunnelId) continue;
    if (typeof entry.alias !== "string" || !/^[A-Za-z0-9._-]+$/.test(entry.alias)) throw new Error("A matching tunnel alias has an invalid identity");
    aliases.add(entry.alias);
  }
  for (const alias of aliases) {
    const status = tunnelStatus({ ...source, tunnel: { ...original, alias } });
    const absent = /not found|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(status.detail);
    if (status.processRunning) throw new DiagnosticError({
      code: "borrowed_tunnel_active", message: "A runtime for the borrowed tunnel is still running; live borrowing is held",
      origin: "tunnel", retryable: false,
    });
    if (!absent && status.state !== "stopped") {
      const state = status.state && KNOWN_RUNTIME_STATES.has(status.state) ? status.state : "unknown";
      throw new DiagnosticError({
        code: "borrowed_tunnel_state_uncertain",
        message: `The borrowed tunnel alias reports ${state} without a confirmed stopped state; live borrowing is held`,
        origin: "tunnel", retryable: false,
        evidenceMissing: "The alias has no running local process, but its tunnel-client state has not settled to stopped.",
      });
    }
  }
}
