import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createRequire } from "node:module";
import { DiagnosticStore } from "../../src/diagnostics/store";
import { signInMessage, signInPage } from "./sign-in";
import { readLauncherBrowserHostDescriptor, readLauncherBrowserHostDescriptorFile } from "../../src/launcher-browser-host";

const require = createRequire(import.meta.url);
const repository = resolve(import.meta.dir, "../..");
const { reviewedElectronBinary } = require(resolve(repository, "launcher/scripts/native-electron.cjs")) as {
  reviewedElectronBinary(selection?: { executable?: string; recordPath?: string }): { executable: string; recordPath: string };
};
export interface OwnedProcess { pid: number; start: string; group: number; executable: string }
export interface GoldenWorkspace {
  version: 1; root: string; campaignId: string; display: string; viewerUrl: string;
  codexHome: string; runtimeHome: string; launcherData: string; descriptorPath: string;
  processes: Record<string, OwnedProcess>;
  nativeRuntime?: { executable: string; recordPath: string };
  signInUrl?: string;
}
function identity(pid: number): OwnedProcess | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, start: fields[19]!, group: Number(fields[2]), executable: realpathSync(`/proc/${pid}/exe`) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}
function owns(process: OwnedProcess): boolean {
  const actual = identity(process.pid);
  return Boolean(actual && actual.start === process.start && actual.executable === process.executable && actual.group === process.group && actual.group === actual.pid);
}
export { identity as ownedProcessIdentity, owns as ownsProcess };

/** A missing leader alone does not prove its browser/helper process group has stopped. */
export function verifyStoppedGoldenLauncher(prior: OwnedProcess): void {
  if (!Number.isSafeInteger(prior.pid) || prior.pid < 2 || prior.group !== prior.pid || identity(prior.pid)) throw new Error("The recorded launcher identity is not fully stopped");
  try { process.kill(-prior.group, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error("The recorded launcher process group still has surviving members");
}
async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function until(check: () => boolean | Promise<boolean>, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("An isolated workspace process exited before readiness");
    if (Date.now() >= deadline) throw new Error("Isolated workspace readiness timed out");
    await wait(100);
  }
}
function binary(name: string, explicit?: string): string {
  const result = explicit && existsSync(explicit) ? explicit : Bun.which(name);
  if (!result) throw new Error(`Missing isolated workspace capability: ${name}`);
  return resolve(result);
}

/** No host display, browser profile, configuration, or OS login item is used. */
export async function startGoldenWorkspace(rootInput: string, toolsInput = join(repository, "context/tools")): Promise<GoldenWorkspace> {
  if (process.platform !== "linux") throw new Error("Hidden headed workspace is supported only on Linux; native platform acceptance remains separate");
  const reviewedElectron = reviewedElectronBinary();
  const root = resolve(rootInput), tools = resolve(toolsInput), statePath = join(root, "workspace.json");
  if (Buffer.byteLength(join(root, "broker.sock")) > 103) throw new Error("Choose a shorter workspace path for the private broker socket");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(statePath)) {
    const prior = JSON.parse(readFileSync(statePath, "utf8")) as GoldenWorkspace;
    if (prior.root !== root || prior.version !== 1) throw new Error("Workspace identity does not match this directory");
    if (Object.values(prior.processes).some(owns)) throw new Error("The isolated workspace is already running; inspect it before starting another");
    throw new Error("An earlier workspace needs explicit cleanup before a new campaign scope starts");
  }
  const storage = statfsSync(root);
  if (storage.bavail * storage.bsize < 2 * 1024 ** 3) throw new Error("At least 2 GiB of free workspace storage is required before admitting live work");
  const xvfb = binary("Xvfb"), xauth = binary("xauth"), xdpyinfo = binary("xdpyinfo");
  const vnc = binary("x11vnc", join(tools, "x11vnc/usr/bin/x11vnc"));
  const python = binary("python", join(tools, "viewer-env/bin/python"));
  const novnc = join(tools, "novnc");
  if (!existsSync(join(novnc, "vnc.html"))) throw new Error("The isolated viewer requires a noVNC installation");
  const viewerWeb = join(root, "viewer-web");
  cpSync(novnc, viewerWeb, { recursive: true, force: false, errorOnExist: true });
  const processes: Record<string, OwnedProcess> = {};
  const children: ChildProcess[] = [];
  const codexHome = join(root, "codex"), runtimeHome = join(root, "runtime"), launcherData = join(root, "launcher");
  for (const path of [codexHome, runtimeHome, launcherData, join(root, "logs")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const campaignId = randomUUID(), xauthority = join(root, "xauthority"), socket = join(root, "viewer.sock");
  if (Buffer.byteLength(socket) >= 104) throw new Error("Choose a shorter workspace path for the private viewer socket");
  const displayNumber = Array.from({ length: 1000 }, (_, index) => 1900 + index).find(index => !existsSync(`/tmp/.X11-unix/X${index}`) && !existsSync(`/tmp/.X${index}-lock`));
  if (displayNumber === undefined) throw new Error("No unused hidden display number is available");
  const display = `:${displayNumber}`;
  writeFileSync(xauthority, "", { mode: 0o600 });
  const auth = Bun.spawnSync([xauth, "-f", xauthority, "source", "-"], { stdin: Buffer.from(`add ${display} . ${randomBytes(16).toString("hex")}\n`), stdout: "ignore", stderr: "pipe" });
  if (auth.exitCode !== 0) throw new Error("Could not initialize the hidden display authority");
  const env = { ...process.env, DISPLAY: display, XAUTHORITY: xauthority, XDG_SESSION_TYPE: "x11" };
  // Child programs receive their documented isolated homes. Host variables are never changed.
  for (const key of Object.keys(env)) if (/^(?:CODEX_|OPENAI_|CHATGPT_|ELECTRON_RUN_AS_NODE$|VITE_DEV_SERVER_URL$|WAYLAND_DISPLAY$)/.test(key)) delete env[key as keyof typeof env];
  const start = async (name: string, executable: string, args: string[], childEnv: NodeJS.ProcessEnv = env, discardLog = false) => {
    const log = openSync(discardLog ? "/dev/null" : join(root, "logs", `${name}.log`), "a", 0o600);
    const child = spawn(executable, args, { cwd: repository, env: childEnv, detached: true, stdio: ["ignore", log, log] });
    children.push(child);
    closeSync(log);
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await until(() => Boolean(child.pid && identity(child.pid)), child);
    processes[name] = identity(child.pid!)!;
    child.unref();
    return child;
  };
  try {
    const desktop = await start("display", xvfb, [display, "-screen", "0", "1440x960x24", "-nolisten", "tcp", "-auth", xauthority]);
    await until(() => Bun.spawnSync([xdpyinfo, "-display", display], { env, stdout: "ignore", stderr: "ignore" }).exitCode === 0, desktop);
    const exporter = await start("viewer-socket", vnc, ["-norc", "-display", display, "-auth", xauthority, "-unixsock", socket, "-rfbport", "0", "-no6", "-forever", "-shared", "-nopw", "-noxdamage", "-nosel", "-quiet"], env, true);
    await until(() => existsSync(socket), exporter);
    const token = randomBytes(32).toString("hex"), tokens = join(root, "viewer-tokens");
    writeFileSync(tokens, `${token}: unix_socket:${socket}\n`, { mode: 0o600 });
    const port = await availablePort();
    const viewerUrl = `http://127.0.0.1:${port}/vnc.html?${new URLSearchParams({ autoconnect: "true", resize: "scale", path: `websockify?token=${token}` })}`;
    const handoffName = `sign-in-${token}.html`, signInUrl = `http://127.0.0.1:${port}/${handoffName}`;
    writeFileSync(join(viewerWeb, handoffName), signInPage(viewerUrl), { mode: 0o600 });
    // A public directory listing must not disclose the private viewer's capability URL.
    writeFileSync(join(viewerWeb, "index.html"), "<!doctype html><title>Isolated test workspace</title><p>Open the private sign-in link printed by your test runner.</p>", { mode: 0o600 });
    const viewer = await start("viewer", python, ["-m", "websockify", "--web", viewerWeb, "--token-plugin", "TokenFile", "--token-source", tokens, "--log-file", "/dev/null", `127.0.0.1:${port}`], env, true);
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/vnc.html`)).ok; } catch { return false; } }, viewer);
    const diagnostics = new DiagnosticStore(join(runtimeHome, "diagnostics/observability"));
    try { diagnostics.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 7 * 86_400_000, maxBytes: 512 * 1024 * 1024 }); }
    finally { diagnostics.close(); }
    if (!existsSync(join(launcherData, "launcher-state.json"))) writeFileSync(join(launcherData, "launcher-state.json"), JSON.stringify({ version: 1, language: "en", onboardingComplete: true, autoStart: false, keepRunningOnClose: true, showBrowserDuringTurns: false }), { mode: 0o600 });
    const bun = process.execPath;
    const launcher = await start("launcher", reviewedElectron.executable, [join(repository, "launcher"), "--codex-home", codexHome, "--ozone-platform=x11"], { ...env, CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID: campaignId, CODEX_CHATGPT_WEB_HOME: runtimeHome, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: launcherData, CODEX_WEB_GPT_ELECTRON_BUILD_RECORD: reviewedElectron.recordPath, CODEX_WEB_GPT_BUN: bun, CODEX_CHATGPT_WEB_BUN: bun });
    const descriptorPath = join(runtimeHome, "runtime/launcher-browser.json");
    await until(() => existsSync(descriptorPath), launcher);
    const state: GoldenWorkspace = { version: 1, root, campaignId, display, viewerUrl, signInUrl, codexHome, runtimeHome, launcherData, descriptorPath, processes, nativeRuntime: reviewedElectron };
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  } catch (error) {
    for (const entry of Object.values(processes).reverse()) if (owns(entry)) process.kill(-entry.pid, "SIGTERM");
    for (const child of children) child.unref();
    throw error;
  }
}

/** Preserve the authenticated isolated partition; the launcher's own idle-only route owns shutdown. */
export async function restartGoldenLauncher(rootInput: string): Promise<GoldenWorkspace> {
  const root = resolve(rootInput), statePath = join(root, "workspace.json");
  const state = JSON.parse(readFileSync(statePath, "utf8")) as GoldenWorkspace;
  if (state.version !== 1 || state.root !== root || realpathSync(root) !== root || state.codexHome !== join(root, "codex") || state.runtimeHome !== join(root, "runtime") || state.launcherData !== join(root, "launcher") || state.descriptorPath !== join(root, "runtime/runtime/launcher-browser.json")) throw new Error("Isolated launcher paths do not match the workspace");
  const prior = state.processes.launcher;
  if (!prior || !state.processes.display || !owns(state.processes.display)) throw new Error("The isolated launcher record and live owned display are required before restart");
  const selectedRuntime = state.nativeRuntime ?? { executable: prior.executable, recordPath: join(dirname(prior.executable), "codex-web-gpt-webauthn-build.json") };
  if (selectedRuntime.executable !== prior.executable) throw new Error("The selected native runtime differs from the owned launcher executable");
  const reviewedElectron = reviewedElectronBinary(selectedRuntime);
  const descriptor = existsSync(state.descriptorPath) ? readLauncherBrowserHostDescriptorFile(state.descriptorPath) : undefined;
  if (descriptor && descriptor.pid !== prior.pid) throw new Error("The browser descriptor belongs to another launcher");
  if (owns(prior)) {
    if (!descriptor) throw new Error("The live isolated launcher has no shutdown control descriptor");
    const response = await fetch(`${descriptor.control.endpoint}/v1/launcher/shutdown-idle`, { method: "POST", headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000) });
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("The isolated launcher did not approve an idle shutdown");
    await until(() => !owns(prior));
  } else verifyStoppedGoldenLauncher(prior);
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: state.display, XAUTHORITY: join(root, "xauthority"), XDG_SESSION_TYPE: "x11" };
  for (const key of Object.keys(env)) if (/^(?:CODEX_|OPENAI_|CHATGPT_|ELECTRON_RUN_AS_NODE$|VITE_DEV_SERVER_URL$|WAYLAND_DISPLAY$)/.test(key)) delete env[key];
  Object.assign(env, { CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID: state.campaignId, CODEX_CHATGPT_WEB_HOME: state.runtimeHome, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: state.launcherData, CODEX_WEB_GPT_ELECTRON_BUILD_RECORD: reviewedElectron.recordPath, CODEX_WEB_GPT_BUN: process.execPath, CODEX_CHATGPT_WEB_BUN: process.execPath });
  const log = openSync(join(root, "logs/launcher.log"), "a", 0o600);
  const child = spawn(reviewedElectron.executable, [join(repository, "launcher"), "--codex-home", state.codexHome, "--ozone-platform=x11"], { cwd: repository, env, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  await until(() => Boolean(child.pid && identity(child.pid)), child);
  state.processes.launcher = identity(child.pid!)!;
  state.nativeRuntime = reviewedElectron;
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  child.unref();
  await until(() => { try { return readLauncherBrowserHostDescriptor(state.descriptorPath).pid === child.pid; } catch { return false; } }, child);
  return state;
}

if (import.meta.main) {
  const rootArgument = process.argv.slice(2).find(argument => argument !== "--json");
  const root = rootArgument ? resolve(rootArgument) : join(repository, "context/golden/live");
  const state = await startGoldenWorkspace(root);
  // Authentication UI is intentionally excluded from diagnostics and screenshots.
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify({ root: state.root, display: state.display, signInUrl: state.signInUrl, viewerUrl: state.viewerUrl, descriptorPath: state.descriptorPath })}\n` : signInMessage({ signInUrl: state.signInUrl!, viewerUrl: state.viewerUrl }));
}
