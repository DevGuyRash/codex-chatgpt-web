const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { reviewedElectronBinary } = require("../scripts/native-electron.cjs");

test("a stopped extension worker releases persistent and one-shot native hosts", {
  skip: process.platform !== "linux" || !process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE,
}, context => {
  const { executable } = reviewedElectronBinary();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-host-worker-stop-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_TEST_SCRATCH_ROOT: root };
  for (const key of ["CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID", "CODEX_CHATGPT_WEB_HOME", "CODEX_HOME", "ELECTRON_RUN_AS_NODE", "OPENAI_API_KEY", "CODEX_API_KEY"]) delete env[key];
  const result = spawnSync("xvfb-run", ["-a", executable, path.join(__dirname, "fixtures", "native-host-worker-stop.cjs"), "--ozone-platform=x11"], {
    cwd: path.resolve(__dirname, ".."), env, encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.slice(-2_000));
  const record = result.stdout.split(/\r?\n/).find(line => line.startsWith("{\"nativeHostsStarted\""));
  assert.ok(record, "Synthetic Electron fixture did not publish its lifecycle result");
  assert.deepEqual(JSON.parse(record), { nativeHostsStarted: 2, nativeHostsExited: 2, stoppedWorkersReleasedHosts: true });
});
