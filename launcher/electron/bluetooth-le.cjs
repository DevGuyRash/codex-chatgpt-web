const { execFile } = require("node:child_process");

function parseBluetoothLeStatus(output) {
  if (typeof output !== "string") return "unknown";
  const blocks = output.split(/^hci\d+:\s*/m).slice(1);
  let supported = false;
  for (const block of blocks) {
    const offered = /^\s*supported settings:\s*(.*)$/m.exec(block)?.[1]?.trim().split(/\s+/) || [];
    const current = /^\s*current settings:\s*(.*)$/m.exec(block)?.[1]?.trim().split(/\s+/) || [];
    if (!offered.includes("le")) continue;
    supported = true;
    if (current.includes("le")) return "available";
  }
  return supported ? "disabled" : "unknown";
}

/** Optional Linux observation; Chromium remains the WebAuthn transport authority. */
function probeBluetoothLe(platform = process.platform, run = execFile) {
  if (platform !== "linux") return Promise.resolve("unknown");
  return new Promise(resolve => {
    run("/usr/bin/btmgmt", ["info"], { timeout: 2000, maxBuffer: 32 * 1024, windowsHide: true }, (error, stdout) => {
      resolve(error ? "unknown" : parseBluetoothLeStatus(stdout));
    });
  });
}

module.exports = { parseBluetoothLeStatus, probeBluetoothLe };
