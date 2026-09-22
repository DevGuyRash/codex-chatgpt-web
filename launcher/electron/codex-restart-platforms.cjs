const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);

async function run(file, args, env) {
  const result = await execute(file, args, { timeout: 5_000, maxBuffer: 512 * 1024, windowsHide: true, env });
  return result.stdout.trim();
}
function launchEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === "CODEX_HOME" || key === "ELECTRON_RUN_AS_NODE" || /^(?:CODEX_CHATGPT_WEB_|CODEX_WEB_GPT_|OPENAI_API_KEY$|CODEX_API_KEY$)/.test(key)) delete env[key];
  return env;
}
async function launch(file, args) {
  const child = spawn(file, args, { detached: true, stdio: "ignore", env: launchEnvironment() });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}

// A deliberately narrow desktop-entry subset. Wrappers, shell entries and custom flags
// have no proven relaunch contract here and remain manual.
function desktopExecutable(text) {
  const section = text.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (!section || !/^Name=Codex\s*$/m.test(section) || !/^Type=Application\s*$/m.test(section)) return null;
  const command = section.match(/^Exec=(.+)$/m)?.[1]?.trim();
  const match = command?.match(/^(?:"(\/[^"`$\\]+)"|(\/[^\s"'`$\\]+))(?:\s+%[uUfF])?$/);
  return match?.[1] ?? match?.[2] ?? null;
}

function linuxAdapter({ io = fs, command = run, relaunch = launch, env = process.env, home = os.homedir(), hostname = os.hostname() } = {}) {
  async function processIdentity(pid) {
    try {
      const stat = await io.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const executable = await io.readlink(`/proc/${pid}/exe`);
      return { executable, identity: `${pid}:${fields[19]}:${executable}` };
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
  }
  async function windows() {
    const text = await command("wmctrl", ["-lp"]);
    return text.split("\n").flatMap(line => {
      const match = line.match(/^(0x[0-9a-f]+)\s+\S+\s+(\d+)\s+(\S+)\s+/i);
      return match && match[3] === hostname ? [{ window: match[1], pid: Number(match[2]) }] : [];
    });
  }
  async function installed() {
    const directories = [...new Set([path.join(env.XDG_DATA_HOME || path.join(home, ".local/share"), "applications"), ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(path.isAbsolute).map(dir => path.join(dir, "applications"))])];
    const entries = new Map();
    for (const directory of directories) {
      let files;
      try { files = await io.readdir(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const file of files.filter(name => name.endsWith(".desktop"))) {
        const entryPath = path.join(directory, file), source = await io.readFile(entryPath, "utf8");
        const executable = desktopExecutable(source);
        if (!executable) continue;
        try {
          const resolved = await io.realpath(executable);
          if (!entries.has(resolved)) entries.set(resolved, { entryPath, source, executable: resolved, label: "Codex", location: resolved, launchSupported: true });
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    return [...entries.values()];
  }
  return {
    installed,
    async discover() {
      const entries = await installed();
      const candidates = new Map();
      // Process identity does not depend on a window manager. Subprocesses sharing
      // Electron's executable are excluded by their explicit process-type argument.
      for (const name of (await io.readdir("/proc")).filter(name => /^\d+$/.test(name))) {
        const pid = Number(name);
        let identity;
        try { identity = await processIdentity(pid); }
        catch (error) {
          if ((error.code === "EACCES" || error.code === "EPERM") && typeof process.getuid === "function") {
            let owner;
            try { owner = await io.stat(`/proc/${pid}`); }
            catch (statError) { if (statError.code === "ENOENT" || statError.code === "ESRCH") continue; throw statError; }
            if (owner.uid !== process.getuid()) continue;
          }
          throw error;
        }
        if (!identity) continue;
        const entry = entries.find(entry => entry.executable === identity.executable);
        if (!entry) continue;
        let args;
        try { args = (await io.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0"); } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
        if (args.some(arg => arg.startsWith("--type="))) continue;
        candidates.set(identity.identity, { ...identity, ...entry, pid, windows: [], closeSupported: false });
      }
      let foundWindows = [];
      if (env.DISPLAY && env.XDG_SESSION_TYPE !== "wayland") {
        try { foundWindows = await windows(); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      for (const window of foundWindows) {
        const process = await processIdentity(window.pid);
        if (!process) continue;
        const matching = entries.filter(entry => entry.executable === process.executable);
        if (matching.length !== 1) continue;
        const properties = await command("xprop", ["-id", window.window, "WM_PROTOCOLS", "WM_CLASS"]);
        if (!/WM_CLASS[^\n]*"[Cc]odex"/.test(properties)) continue;
        const entry = matching[0];
        const previous = candidates.get(process.identity);
        const closeSupported = /WM_PROTOCOLS[^\n]*\bWM_DELETE_WINDOW\b/.test(properties);
        if (previous) { previous.closeSupported = previous.windows.length ? previous.closeSupported && closeSupported : closeSupported; previous.windows.push(window.window); }
        else candidates.set(process.identity, { ...process, ...entry, pid: window.pid, windows: [window.window], label: "Codex", location: entry.executable, launchEntry: entry.entryPath, closeSupported });
      }
      return [...candidates.values()];
    },
    async sameInstance(app) { return (await processIdentity(app.pid))?.identity === app.identity; },
    async close(app) {
      const current = (await this.discover()).find(candidate => candidate.identity === app.identity);
      if (!current?.closeSupported || current.source !== app.source) throw new Error("Desktop application identity changed");
      for (const window of current.windows) await command("wmctrl", ["-ic", window]);
    },
    async launch(app) {
      if (await io.readFile(app.entryPath, "utf8") !== app.source || await io.realpath(desktopExecutable(app.source)) !== app.executable) throw new Error("Application entry changed");
      await relaunch(app.executable, []);
    },
  };
}

const macScript = `ObjC.import('AppKit');
function run(args) {
  const mode = args[0];
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const found = [];
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    const bundle = ObjC.unwrap(app.bundleIdentifier);
    if (bundle !== 'com.openai.codex') continue;
    const item = { pid: Number(app.processIdentifier), label: 'Codex', location: ObjC.unwrap(app.bundleURL.path), executable: ObjC.unwrap(app.executableURL.path), started: Number(app.launchDate.timeIntervalSince1970), closeSupported: true };
    item.identity = item.pid + ':' + item.started + ':' + item.executable;
    if (mode === 'close' && item.identity === args[1]) { if (!app.terminate) throw Error('Normal quit was declined'); return 'closed'; }
    found.push(item);
  }
  if (mode === 'close') throw Error('Application identity changed');
  return JSON.stringify(found);
}`;

const windowsScript = `$ErrorActionPreference = 'Stop'
$found = @()
foreach ($app in (Get-Process)) {
  if ($app.MainWindowHandle -eq 0) { continue }
  try { $file = $app.MainModule.FileName; $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($file) } catch { continue }
  if ($info.ProductName -ne 'Codex' -or $info.CompanyName -notmatch 'OpenAI') { continue }
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenAI') { continue }
  $identity = [string]$app.Id + ':' + $app.StartTime.ToUniversalTime().Ticks + ':' + $file
  if ($env:CGW_RESTART_MODE -eq 'close' -and $identity -eq $env:CGW_RESTART_IDENTITY) {
    if (-not $app.CloseMainWindow()) { throw 'Normal close was declined' }
    'closed'; exit
  }
  $found += @{ pid = $app.Id; label = 'Codex'; location = $file; executable = $file; identity = $identity; closeSupported = $true }
}
if ($env:CGW_RESTART_MODE -eq 'close') { throw 'Application identity changed' }
ConvertTo-Json -InputObject @($found) -Compress
`;

function nativeAdapter(platform, { command = run, relaunch = launch } = {}) {
  const inspect = async (mode = "discover", identity = "") => platform === "darwin"
    ? command("/usr/bin/osascript", ["-l", "JavaScript", "-e", macScript, mode, identity])
    : command(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", windowsScript], { ...process.env, CGW_RESTART_MODE: mode, CGW_RESTART_IDENTITY: identity });
  return {
    async discover() {
      const candidates = JSON.parse(await inspect());
      if (!Array.isArray(candidates) || candidates.some(item => !Number.isSafeInteger(item.pid) || item.pid < 1 || typeof item.identity !== "string" || typeof item.executable !== "string" || typeof item.location !== "string")) throw new Error("Invalid application discovery");
      return candidates;
    },
    async sameInstance(app) {
      // Window enumeration cannot prove exit: a closed window may leave a background process.
      if (platform === "darwin") return (await this.discover()).some(candidate => candidate.identity === app.identity);
      const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'exited' } else { [string]$p.Id + ':' + $p.StartTime.ToUniversalTime().Ticks + ':' + $p.MainModule.FileName }`;
      const result = await command(path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script]);
      return result === app.identity;
    },
    async close(app) { await inspect("close", app.identity); },
    async launch(app) {
      if (platform === "darwin") await relaunch("/usr/bin/open", ["-a", app.location]);
      else await relaunch(app.executable, []);
    },
  };
}
function createRestartAdapter(platform = process.platform) {
  if (platform === "linux") return linuxAdapter();
  if (platform === "darwin" || platform === "win32") return nativeAdapter(platform);
  return { discover: async () => [] };
}
module.exports = { createRestartAdapter, desktopExecutable, linuxAdapter, nativeAdapter };
