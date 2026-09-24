const fs = require("node:fs");
const path = require("node:path");

const NORMAL_DESKTOP_NAME = "codex-web-gpt.desktop";
const DEVELOPMENT_DESKTOP_NAME = "codex-web-gpt-dev.desktop";

function launcherIconPath({ packaged, isDevelopment = false, resourcesPath = process.resourcesPath }) {
  const filename = isDevelopment ? "dev-icon.png" : "icon.png";
  const icon = packaged
    ? path.join(resourcesPath, "app.asar.unpacked", "assets", filename)
    : path.join(__dirname, "..", "assets", filename);
  if (!fs.statSync(icon, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The launcher icon is missing from the reviewed runtime");
  }
  return icon;
}

let cachedWindowIcon;
let cachedWindowIconPath;
let cachedNativeImage;

function launcherWindowIcon(nativeImage, options) {
  const iconPath = launcherIconPath(options);
  if (cachedWindowIcon && cachedWindowIconPath === iconPath && cachedNativeImage === nativeImage) return cachedWindowIcon;
  if (!nativeImage || typeof nativeImage.createFromPath !== "function") {
    throw new Error("The native launcher icon decoder is unavailable");
  }
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error("The reviewed launcher icon could not be decoded");
  const windowIcon = icon.resize({ width: 128, height: 128 });
  if (windowIcon.isEmpty()) throw new Error("The reviewed launcher window icon is empty");
  cachedWindowIconPath = iconPath;
  cachedNativeImage = nativeImage;
  cachedWindowIcon = windowIcon;
  return windowIcon;
}

function desktopNameForProfile(isDevelopment) {
  return isDevelopment ? DEVELOPMENT_DESKTOP_NAME : NORMAL_DESKTOP_NAME;
}

module.exports = { launcherIconPath, launcherWindowIcon, desktopNameForProfile, NORMAL_DESKTOP_NAME, DEVELOPMENT_DESKTOP_NAME };
