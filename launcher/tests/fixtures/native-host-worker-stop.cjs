const { app, session } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ElectronChromeExtensions } = require("../../node_modules/electron-chrome-extensions");

const root = process.env.CODEX_TEST_SCRATCH_ROOT;
if (!root || !path.isAbsolute(root) || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error("Synthetic native-host fixture requires an owned scratch directory");
}
const hostPidPath = path.join(root, "host.pid");
const hostPath = path.join(root, "host.sh");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const application = "com.codex_web_gpt.synthetic_host";
fs.writeFileSync(hostPath, `#!/bin/sh\nprintf '%s' "$$" > '${hostPidPath}'\nexec /bin/sleep 300\n`, { mode: 0o700 });
fs.mkdirSync(path.join(root, "NativeMessagingHosts"));
fs.writeFileSync(path.join(root, "NativeMessagingHosts", `${application}.json`), JSON.stringify({
  name: application, description: "Synthetic lifecycle host", path: hostPath, type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
}));
app.setPath("userData", root);

const wait = async (check, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Synthetic native host did not settle before its deadline");
};
const alive = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; }
  catch { return false; }
};

app.whenReady().then(async () => {
  let childPid, oneShotPid;
  try {
    const browserSession = session.fromPartition(`persist:synthetic-${process.pid}`);
    const extensions = new ElectronChromeExtensions({ license: "GPL-3.0", session: browserSession,
      createTab: () => { throw new Error("Unexpected synthetic tab"); },
      createWindow: () => { throw new Error("Unexpected synthetic window"); },
    });
    const lifecycle = [];
    extensions.on("native-messaging-lifecycle", event => lifecycle.push(event.phase));
    const sender = new EventEmitter();
    sender.versionId = 123456;
    sender.ipc = new EventEmitter();
    sender.send = () => {};
    await extensions.api.runtime.connectNative({ extension: { id: extensionId }, sender }, randomUUID(), application);
    await wait(() => fs.existsSync(hostPidPath), 5_000);
    childPid = Number(fs.readFileSync(hostPidPath, "utf8"));
    if (!Number.isSafeInteger(childPid) || !alive(childPid)) throw new Error("Synthetic native host never started");
    browserSession.serviceWorkers.emit("running-status-changed", { runningStatus: "stopped", versionId: sender.versionId });
    await wait(() => !alive(childPid), 5_000);
    const oneShotSender = new EventEmitter();
    oneShotSender.versionId = sender.versionId + 1;
    oneShotSender.ipc = new EventEmitter();
    oneShotSender.send = () => {};
    const oneShot = extensions.api.runtime.sendNativeMessage({ extension: { id: extensionId }, sender: oneShotSender }, application, { fixture: true });
    await wait(() => lifecycle.filter(phase => phase === "started").length === 2, 5_000);
    oneShotPid = Number(fs.readFileSync(hostPidPath, "utf8"));
    if (oneShotPid === childPid || !alive(oneShotPid)) throw new Error("Synthetic one-shot native host never started");
    browserSession.serviceWorkers.emit("running-status-changed", { runningStatus: "stopped", versionId: oneShotSender.versionId });
    const rejection = await oneShot.then(() => null, error => error);
    if (!(rejection instanceof Error) || !/disconnected/.test(rejection.message)) throw new Error("Stopped one-shot worker did not settle its response");
    await wait(() => !alive(oneShotPid), 5_000);
    await wait(() => lifecycle.filter(phase => phase === "exit").length === 2, 5_000);
    console.log(JSON.stringify({ nativeHostsStarted: lifecycle.filter(phase => phase === "started").length, nativeHostsExited: lifecycle.filter(phase => phase === "exit").length, stoppedWorkersReleasedHosts: true }));
  } finally {
    if (childPid && alive(childPid)) { try { process.kill(childPid, "SIGTERM"); } catch {} }
    if (oneShotPid && alive(oneShotPid)) { try { process.kill(oneShotPid, "SIGTERM"); } catch {} }
    app.quit();
  }
}).catch(error => { console.error(error instanceof Error ? error.message : String(error)); app.exit(1); });
