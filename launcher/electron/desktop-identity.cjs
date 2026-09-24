const fs = require("node:fs");
const path = require("node:path");

const NORMAL_DESKTOP_NAME = "codex-web-gpt.desktop";
const DEVELOPMENT_DESKTOP_NAME = "codex-web-gpt-dev.desktop";

function launcherIconPath(packaged, resourcesPath = process.resourcesPath) {
  const icon = packaged
    ? path.join(resourcesPath, "app.asar.unpacked", "assets", "icon.png")
    : path.join(__dirname, "..", "assets", "icon.png");
  if (!fs.statSync(icon, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The launcher icon is missing from the reviewed runtime");
  }
  return icon;
}

let cachedWindowIcon;
let cachedWindowIconPath;
let cachedNativeImage;

function launcherWindowIcon(nativeImage, packaged, resourcesPath) {
  const iconPath = launcherIconPath(packaged, resourcesPath);
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
