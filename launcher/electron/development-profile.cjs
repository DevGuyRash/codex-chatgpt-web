const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const SHORTCUT_NAME = "codex-web-gpt-dev.desktop";
const MANAGED_MARKER = "X-Codex-Web-GPT-Managed=true";

function defaultDevelopmentHome(homeDir = os.homedir()) {
  return path.join(homeDir, ".codex-chatgpt-web-dev");
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalDirectory(value) {
  const resolved = path.resolve(value);
  const entry = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (entry) {
    if (!fs.statSync(resolved).isDirectory()) throw new Error("DEV home must be a directory");
    return fs.realpathSync(resolved);
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) throw new Error("DEV home has no existing parent");
  return path.join(canonicalDirectory(parent), path.basename(resolved));
}

function validateDevelopmentHome(home, protectedHomes) {
  if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0")) throw new Error("DEV home must be an absolute directory");
  const canonical = canonicalDirectory(home);
  if (protectedHomes.some(protectedHome => {
    const protectedCanonical = canonicalDirectory(protectedHome);
    return overlaps(canonical, protectedCanonical) || overlaps(protectedCanonical, canonical);
  })) throw new Error("DEV home must be separate from the normal launcher and Codex homes");
  return canonical;
}

function developmentLaunchEnvironment(source, home) {
  const env = { ...source };
  for (const key of ["CODEX_CHATGPT_WEB_HOME", "CODEX_HOME", "CODEX_WEB_GPT_LAUNCHER_DATA_DIR", "CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID", "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR", "CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN", "ELECTRON_RUN_AS_NODE", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[key];
  env.CODEX_WEB_GPT_DEV_HOME = home;
  return env;
}

function desktopArgument(value) {
  return `"${String(value).replaceAll("%", "%%").replace(/["`$\\]/g, "\\$&")}"`;
}

function developmentDesktopEntry(home, executable, icon) {
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Codex Web GPT DEV\nComment=Open the isolated development profile\nExec=/usr/bin/env ${desktopArgument(`CODEX_WEB_GPT_DEV_HOME=${home}`)} ${desktopArgument(executable)} --dev-profile\nTryExec=${desktopArgument(executable)}\nIcon=${icon}\nTerminal=false\nCategories=Development;\nStartupWMClass=codex-web-gpt-dev\n${MANAGED_MARKER}\n`;
}

function installLinuxDevelopmentShortcut({ home, executable, iconSource, dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share") }) {
  if (process.platform !== "linux") return "not-applicable";
  if (!path.isAbsolute(executable) || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return "unavailable";
  const target = path.join(dataHome, "applications", SHORTCUT_NAME);
  let current;
  try { current = fs.readFileSync(target, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current && !current.includes(MANAGED_MARKER)) return "existing-unmanaged";
  if (!path.isAbsolute(iconSource || "") || !fs.statSync(iconSource, { throwIfNoEntry: false })?.isFile()) return "unavailable";
  // An AppImage mount is temporary. Keep the reviewed DEV asset under the user's
  // stable data home so a pinned shortcut never falls back to another app's icon.
  const icon = path.join(dataHome, "icons", "codex-web-gpt-dev.png");
  const image = fs.readFileSync(iconSource);
  let previousImage;
  try { previousImage = fs.readFileSync(icon); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const iconChanged = !previousImage?.equals(image);
  if (iconChanged) writePrivateFileAtomic(icon, image);
  const desired = developmentDesktopEntry(home, executable, icon);
  if (current === desired) return iconChanged ? "installed" : "present";
  writePrivateFileAtomic(target, desired);
  return "installed";
}

module.exports = { defaultDevelopmentHome, validateDevelopmentHome, developmentLaunchEnvironment, developmentDesktopEntry, installLinuxDevelopmentShortcut };
