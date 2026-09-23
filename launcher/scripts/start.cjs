const { spawn } = require("node:child_process");
const path = require("node:path");
const { reviewedElectronBinary } = require("./native-electron.cjs");

const root = path.resolve(__dirname, "..");
const { executable, recordPath } = reviewedElectronBinary();
const child = spawn(executable, [root, "--dev-profile"], {
  cwd: root, stdio: "inherit", shell: false,
  env: { ...process.env, CODEX_WEB_GPT_ELECTRON_BUILD_RECORD: recordPath },
});
child.once("exit", code => { process.exitCode = code ?? 1; });
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
