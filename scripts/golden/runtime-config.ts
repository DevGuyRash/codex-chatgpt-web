import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CHATGPT_CONNECTOR_NAME, ZERO_RISK_CHATGPT_CONNECTOR_NAME, defaultConfig, getConfigDir, resolveSetupConnectorName, type AppConfig } from "../../src/config";
import { containsPath } from "../../src/diagnostics/paths";
import { createTunnelConfig } from "../../src/tunnel";
import type { Protocol } from "./catalog";
import type { GoldenWorkspace } from "./workspace";
import { readBorrowedTunnel } from "./borrowed-tunnel";
import { installCodexInterruptHook } from "../../src/codex-interrupt-hook";
import { installCompatibilityV1Features } from "../../src/codex-integration-document";

const runtimeCommand = [process.execPath, resolve(import.meta.dir, "../../src/cli.ts")];

/** Prepare the service-free runtime configuration. The caller owns startup and settlement. */
export function prepareGoldenRuntimeConfig(input: {
  workspace: GoldenWorkspace; protocol: Protocol; connectorName: string;
  tunnelId: string; tunnelBinary: string; runtimeKeyFile: string;
  capabilities: { solAvailable: boolean; proAvailable: boolean };
  borrowFromRuntimeHome?: string;
}): AppConfig {
  const { workspace } = input;
  const root = realpathSync(workspace.root), runtimeHome = realpathSync(workspace.runtimeHome);
  if (root !== workspace.root || runtimeHome !== workspace.runtimeHome || !containsPath(root, runtimeHome) || root === runtimeHome
    || resolve(getConfigDir()) !== runtimeHome) throw new Error("Golden runtime requires its own canonical home in this process");
  const brokerSocketPath = join(root, "broker.sock");
  if (Buffer.byteLength(brokerSocketPath) > 103 || (statSync(root).mode & 0o077) !== 0) throw new Error("Golden broker requires a short, private workspace socket path");
  if (process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID !== workspace.campaignId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(workspace.campaignId)) throw new Error("Golden runtime requires its exact active campaign identity");
  if (input.protocol !== "native" && input.protocol !== "compatibility-v1") throw new Error("Unknown golden protocol");
  for (const path of [workspace.descriptorPath, input.tunnelBinary, input.runtimeKeyFile]) {
    if (resolve(path) !== path || realpathSync(path) !== path || !statSync(path).isFile()) throw new Error("Golden runtime inputs require canonical regular files");
  }
  if (!containsPath(runtimeHome, workspace.descriptorPath)) throw new Error("Golden browser descriptor must belong to the isolated runtime");
  const connectorName = resolveSetupConnectorName(undefined, input.connectorName);
  if (!input.connectorName.trim() || (!input.borrowFromRuntimeHome && (connectorName === CHATGPT_CONNECTOR_NAME || connectorName === ZERO_RISK_CHATGPT_CONNECTOR_NAME))) throw new Error("Golden runtime requires a dedicated connector name or its explicit existing-tunnel source");
  const alias = `golden-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
  const tunnel = createTunnelConfig({ binaryPath: input.tunnelBinary, tunnelId: input.tunnelId, runtimeKeyFile: input.runtimeKeyFile, alias, profileName: alias });
  if (input.borrowFromRuntimeHome) readBorrowedTunnel(input.borrowFromRuntimeHome, root, { appName: connectorName, tunnel });
  return {
    ...defaultConfig("full", runtimeHome), ...input.capabilities,
    subagentProtocol: input.protocol, port: 0,
    brokerSocketPath,
    appName: connectorName, automaticAppName: connectorName,
    browserHost: "launcher", browserHostDescriptorPath: workspace.descriptorPath,
    runtimeCommand: [...runtimeCommand, "--home", runtimeHome],
    tunnel, automaticTunnel: tunnel,
    zeroRiskProEnabled: false,
  };
}

/** Native homes receive this provider explicitly; production Native configuration is never edited. */
export function goldenArtifactWritableRoots(repository: string): string[] {
  const gitDirectory = join(repository, ".git");
  if (realpathSync(repository) !== repository || realpathSync(gitDirectory) !== gitDirectory || !statSync(gitDirectory).isDirectory()) throw new Error("Artifact commits require a canonical disposable Git directory");
  return [gitDirectory];
}

export function goldenNativeConfig(input: { catalogPath: string; port: number; artifactRepository?: string; integration?: { nativeConfigPath: string; runtimeHome: string; protocol: Protocol } }): string {
  if (resolve(input.catalogPath) !== input.catalogPath || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Golden native provider requires its absolute catalog and bound loopback port");
  let gitPermission = "";
  if (input.artifactRepository) {
    gitPermission = `[sandbox_workspace_write]\nwritable_roots=${JSON.stringify(goldenArtifactWritableRoots(input.artifactRepository))}\n`;
  }
  let text = `model_catalog_json=${JSON.stringify(input.catalogPath)}\nallow_login_shell=false\n${gitPermission}[shell_environment_policy]\nexperimental_use_profile=false\n[model_providers.golden]\nname="Isolated golden runtime"\nbase_url="http://127.0.0.1:${input.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[analytics]\nenabled=false\n`;
  if (input.integration) {
    const { nativeConfigPath, runtimeHome, protocol } = input.integration;
    if (resolve(nativeConfigPath) !== nativeConfigPath || resolve(runtimeHome) !== runtimeHome || !["native", "compatibility-v1"].includes(protocol)) throw new Error("Golden integration requires absolute configuration paths and its selected protocol");
    if (protocol === "compatibility-v1") text = installCompatibilityV1Features(text).text;
    text = installCodexInterruptHook(text, nativeConfigPath, { runtimeCommand }, runtimeHome).text;
  }
  return text;
}

/** Personal executable interceptors and login profiles do not belong to disposable task execution. */
export function goldenNativeEnvironment(work: string, nativeHome: string, nativeExecutable: string): NodeJS.ProcessEnv {
  for (const path of [work, nativeHome, nativeExecutable]) if (resolve(path) !== path) throw new Error("Native test environment requires absolute owned paths");
  return { PATH: [dirname(process.execPath), dirname(nativeExecutable), "/usr/bin", "/bin"].join(":"), HOME: work, CODEX_HOME: nativeHome, SHELL: "/bin/bash", LANG: "C.UTF-8" };
}
