const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function fileSha256(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

function reviewedElectronBinary(selection = {}) {
  const executable = selection.executable || process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE;
  if (!executable || !path.isAbsolute(executable)
    || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Set CODEX_WEB_GPT_ELECTRON_EXECUTABLE to the compiled WebAuthn-enabled Electron binary");
  }
  const recordPath = selection.recordPath || process.env.CODEX_WEB_GPT_ELECTRON_BUILD_RECORD
    || path.join(path.dirname(executable), "codex-web-gpt-webauthn-build.json");
  if (!path.isAbsolute(recordPath)
    || !fs.statSync(recordPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("The compiled WebAuthn Electron build record is missing");
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(record.binarySha256)
    || fileSha256(executable) !== record.binarySha256) {
    throw new Error("The development Electron executable does not match its reviewed WebAuthn build record");
  }
  return { executable, recordPath };
}

module.exports = { reviewedElectronBinary };
