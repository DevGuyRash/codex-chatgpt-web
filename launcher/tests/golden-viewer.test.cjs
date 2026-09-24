const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { activeGoldenViewer } = require("../electron/golden-viewer.cjs");

test("private viewer access requires live owned workspace processes and its exact token", { skip: process.platform !== "linux" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "golden-viewer-"));
  const children = [];
  try {
    const processes = {};
    for (const name of ["display", "viewer-socket", "viewer", "launcher"]) {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      children.push(child);
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes[name] = { pid: child.pid, start: fields[19], group: child.pid, executable: fs.realpathSync(`/proc/${child.pid}/exe`) };
    }
    const token = "a".repeat(64);
    const url = `http://127.0.0.1:45678/vnc.html?autoconnect=true&resize=scale&path=websockify%3Ftoken%3D${token}`;
    const state = { version: 1, root, display: ":1900", viewerUrl: url, processes };
    fs.writeFileSync(path.join(root, "viewer.sock"), "");
    fs.writeFileSync(path.join(root, "viewer-tokens"), `${token}: unix_socket:${path.join(root, "viewer.sock")}\n`);
    const save = () => fs.writeFileSync(path.join(root, "workspace.json"), JSON.stringify(state));
    save();
    assert.equal(activeGoldenViewer(root).url, url);
    fs.writeFileSync(path.join(root, "viewer-tokens"), `${"b".repeat(64)}: unix_socket:${path.join(root, "viewer.sock")}\n`);
    assert.throws(() => activeGoldenViewer(root), /token does not match/);
    fs.writeFileSync(path.join(root, "viewer-tokens"), `${token}: unix_socket:${path.join(root, "viewer.sock")}\n`);
    state.processes.launcher.start = "stale";
    save();
    assert.throws(() => activeGoldenViewer(root), /launcher process is no longer owned/);
  } finally {
    for (const child of children) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
