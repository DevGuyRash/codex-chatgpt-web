import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { installCodexInterruptHookCommand } from "./codex-interrupt-hook";
import { atomicWriteFile } from "./config";
import type { IntegrationTarget } from "./contracts/codex-integration";

const capabilities = ["profile-precedence", "profile-catalog", "native-cache-isolation", "profile-launch", "interrupt-trust-identity"] as const;
export interface ProfileCapabilities {
  version: 1;
  executable: string;
  binarySha256: string;
  codexVersion: string;
  platform: NodeJS.Platform;
  capabilities: typeof capabilities[number][];
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shellArgument = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const plain = (value: string) => value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b[()][A-Za-z0-9]/g, "");

function isolatedEnvironment(root: string, codexHome: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COMSPEC: process.env.COMSPEC,
    HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, TMPDIR: root, TMP: root, TEMP: root,
    CODEX_HOME: codexHome, TERM: "xterm", COLUMNS: "120", LINES: "40" };
}

/** A fixed, non-message UI probe. It never runs a turn or approves a hook through the UI. */
async function inspectFixtureHook(executable: string, root: string, env: NodeJS.ProcessEnv, active: 0 | 1): Promise<void> {
  if (process.platform !== "linux" || !existsSync("/usr/bin/script")) throw new Error("Profile hook capability verification requires the supported Linux PTY probe; this platform is not yet verified and profile installation remains blocked");
  const command = "/usr/bin/stty rows 40 cols 120 && exec " + [executable, "--profile", "cgw-probe", "--no-alt-screen"].map(shellArgument).join(" ");
  const child = spawn("/usr/bin/script", ["-qefc", command, "/dev/null"], { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let failure: Error | undefined;
  let exited = false;
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-1_000_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.stdin.on("error", error => { failure = error; });
  child.on("error", error => { failure = error; });
  const closed = new Promise<void>(resolve => child.once("close", () => { exited = true; resolve(); }));
  const waitFor = async (matches: (text: string) => boolean, label: string) => {
    const deadline = Date.now() + 12_000;
    while (!matches(plain(output))) {
      if (failure || exited || Date.now() >= deadline) throw new Error(`Codex capability probe could not confirm ${label}; profile installation remains blocked. ${plain(output).slice(-1_500)}`);
      await delay(40);
    }
  };
  try {
    if (!active) {
      await waitFor(text => text.includes("Hooks need review") && text.includes("Continuewithouttrusting"), "the changed hook trust review");
      // Reject trust for this deliberately mismatched fixture; never approve via terminal automation.
      child.stdin.write("\x1b[B\x1b[B");
      await delay(180);
      child.stdin.write("\r");
    }
    await waitFor(text => /cgw-offline-profile high/.test(text), "profile-local launch and model selection");
    output = "";
    child.stdin.write("/model");
    await delay(180);
    child.stdin.write("\r");
    await waitFor(text => /Select.*[Mm]odel/.test(text) && text.includes("cgw-offline-profile"), "profile-local model catalog selection");
    if (plain(output).includes("cgw-offline-base")) throw new Error("The base model catalog leaked into the profile selector; profile installation remains blocked");
    child.stdin.write("\x1b");
    await delay(180);
    child.stdin.write("/hooks");
    await delay(180); // Separate typed command from Enter so Codex's paste detector cannot turn it into a prompt.
    child.stdin.write("\r");
    await waitFor(text => new RegExp(`Interrupt\\s+1\\s+${active}\\s`).test(text), active ? "trusted profile-local Interrupt activation" : "rejection of a mismatched Interrupt trust identity");
  } finally {
    if (!exited && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* Already exited. */ } }, 1_000);
      try { await closed; } finally { clearTimeout(timer); }
    }
  }
}

/** Probe a specifically selected binary against disposable configuration, never the user's auth/session. */
export async function probeCodexProfileCapabilities(binary: string): Promise<ProfileCapabilities> {
  if (!isAbsolute(binary)) throw new Error("Select the absolute path to the Codex CLI binary for profile capability verification; existing codex wrappers are not replaced");
  const executable = realpathSync.native(binary);
  const binarySha256 = sha256(readFileSync(executable));
  const root = mkdtempSync(join(tmpdir(), "cgw-capability-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { mode: 0o700 });
  const env = isolatedEnvironment(root, codexHome);
  const run = (args: string[]) => {
    const result = spawnSync(executable, args, { cwd: root, env, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error(`Codex capability check failed for ${args.join(" ")}; no user configuration was changed. ${result.stderr.slice(0, 800)}`);
    return result.stdout;
  };
  try {
    const codexVersion = run(["--version"]).trim();
    if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(codexVersion)) throw new Error("The selected executable is not a recognizable Codex CLI binary; select the binary behind your wrapper");
    const bundled: unknown = JSON.parse(run(["debug", "models", "--bundled"]));
    if (!bundled || typeof bundled !== "object" || !Array.isArray((bundled as { models?: unknown }).models)) throw new Error("This Codex binary cannot expose a native catalog for isolated profile verification");
    const native = (bundled as { models: Record<string, unknown>[] }).models.find(model => model.visibility === "list");
    if (!native) throw new Error("This Codex binary has no native model template for isolated profile verification");
    for (const name of ["base", "profile"]) writeFileSync(join(root, `${name}.json`), JSON.stringify({ models: [{ ...native, slug: `cgw-offline-${name}`, display_name: `cgw-offline-${name}` }] }), { mode: 0o600 });
    const base = [
      'model="cgw-offline-base"', 'model_reasoning_effort="low"', 'developer_instructions="CGW_BASE_PRECEDENCE_SENTINEL"',
      `model_catalog_json=${JSON.stringify(join(root, "base.json"))}`, 'openai_base_url="http://127.0.0.1:1/v1"',
      'check_for_update_on_startup=false', 'cli_auth_credentials_store="file"',
      `[projects.${JSON.stringify(root)}]`, 'trust_level="trusted"', "",
    ].join("\n");
    const profilePath = join(codexHome, "cgw-probe.config.toml");
    const profile = installCodexInterruptHookCommand([
      'model="cgw-offline-profile"', 'model_reasoning_effort="high"', 'developer_instructions="CGW_PROFILE_PRECEDENCE_SENTINEL"',
      `model_catalog_json=${JSON.stringify(join(root, "profile.json"))}`, "",
    ].join("\n"), profilePath, "cgw-offline-probe-never-executed");
    writeFileSync(join(codexHome, "config.toml"), base, { mode: 0o600 });
    writeFileSync(profilePath, profile.text, { mode: 0o600 });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "offline-fixture-not-a-credential" }), { mode: 0o600 });
    const cache = JSON.stringify({ models: [], cgw: "native-cache-preservation-sentinel" });
    writeFileSync(join(codexHome, "models_cache.json"), cache, { mode: 0o600 });
    const prompt = run(["--profile", "cgw-probe", "debug", "prompt-input"]);
    if (!prompt.includes("CGW_PROFILE_PRECEDENCE_SENTINEL") || prompt.includes("CGW_BASE_PRECEDENCE_SENTINEL")) throw new Error("Codex profile precedence is unavailable; profile installation remains blocked");
    const models = JSON.parse(run(["debug", "models"]));
    if (models.models?.length !== 1 || models.models[0]?.slug !== "cgw-offline-base") throw new Error("Codex does not read the configured base catalog; profile installation remains blocked");
    await inspectFixtureHook(executable, root, env, 1);
    writeFileSync(profilePath, profile.text.replace(profile.installed.trustedHash, `sha256:${"0".repeat(64)}`), { mode: 0o600 });
    await inspectFixtureHook(executable, root, env, 0);
    if (readFileSync(join(codexHome, "models_cache.json"), "utf8") !== cache || readFileSync(join(codexHome, "config.toml"), "utf8") !== base) throw new Error("Codex profile verification changed shared native configuration or catalog cache; profile installation remains blocked");
    if (sha256(readFileSync(executable)) !== binarySha256) throw new Error("Codex binary changed during verification; repeat the capability check");
    return { version: 1, executable, binarySha256, codexVersion, platform: process.platform, capabilities: [...capabilities] };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export function profileCapabilityPath(target: IntegrationTarget): string { return join(target.runtimeHome, "codex", "profile-capabilities.json"); }
export function saveProfileCapabilities(target: IntegrationTarget, evidence: ProfileCapabilities): void {
  atomicWriteFile(profileCapabilityPath(target), `${JSON.stringify(evidence, null, 2)}\n`);
}
export function assertProfileCapabilities(target: IntegrationTarget): ProfileCapabilities {
  let evidence: Partial<ProfileCapabilities>;
  try { evidence = JSON.parse(readFileSync(profileCapabilityPath(target), "utf8")); }
  catch { throw new Error("This profile requires an isolated Codex capability check. Run targets check with --codex-binary and the same target selectors before installation."); }
  if (evidence.version !== 1 || evidence.platform !== process.platform || typeof evidence.executable !== "string" || !isAbsolute(evidence.executable)
    || !Array.isArray(evidence.capabilities) || !capabilities.every(item => evidence.capabilities!.includes(item))
    || !existsSync(evidence.executable) || sha256(readFileSync(evidence.executable)) !== evidence.binarySha256) throw new Error("Codex profile capability evidence is missing, incompatible, or stale; repeat targets check before installation");
  return evidence as ProfileCapabilities;
}
