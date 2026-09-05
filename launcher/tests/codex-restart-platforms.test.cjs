const test = require("node:test");
const assert = require("node:assert/strict");
const { desktopExecutable, linuxAdapter, nativeAdapter } = require("../electron/codex-restart-platforms.cjs");

test("Linux desktop entries exclude wrappers and executable substitutions", () => {
  const entry = exec => `[Desktop Entry]\nName=Codex\nType=Application\nExec=${exec}\n`;
  assert.equal(desktopExecutable(entry('"/opt/Codex App/codex" %U')), "/opt/Codex App/codex");
  for (const value of ["sh -c codex", "/usr/bin/env codex", "codex", "/opt/codex --arbitrary", '"/opt/$command/codex"']) assert.equal(desktopExecutable(entry(value)), null);
});

test("Linux matches a desktop executable to its local window and rechecks close support", async () => {
  const source = "[Desktop Entry]\nName=Codex\nType=Application\nExec=/opt/codex %U\n";
  const calls = [];
  const io = {
    readdir: async dir => dir === "/fixture/applications" ? ["codex.desktop"] : [],
    readFile: async file => file.endsWith(".desktop") ? source : `123 (codex) ${Array.from({ length: 20 }, (_, i) => i === 19 ? "456" : "0").join(" ")}`,
    readlink: async () => "/opt/codex", realpath: async file => file,
  };
  let protocols = 'WM_PROTOCOLS(ATOM): WM_DELETE_WINDOW\nWM_CLASS(STRING) = "codex", "Codex"';
  const command = async (file, args) => { calls.push([file, args]); return args[0] === "-lp" ? "0x001 0 123 fixture-host Codex\n0x002 0 999 foreign-host Codex" : file === "xprop" ? protocols : ""; };
  const adapter = linuxAdapter({ io, command, env: { DISPLAY: ":fixture", XDG_DATA_HOME: "/fixture", XDG_DATA_DIRS: "/system" }, hostname: "fixture-host", relaunch: async (...args) => calls.push(args) });
  const apps = await adapter.discover();
  assert.equal(apps.length, 1);
  assert.equal(apps[0].identity, "123:456:/opt/codex");
  await adapter.close(apps[0]);
  assert.ok(calls.some(([file, args]) => file === "wmctrl" && args.join(" ") === "-ic 0x001"));
  protocols = 'WM_PROTOCOLS(ATOM): WM_TAKE_FOCUS\nWM_CLASS(STRING) = "codex", "Codex"';
  await assert.rejects(adapter.close(apps[0]), /identity changed/);
  assert.equal((await adapter.discover())[0].closeSupported, false);
  await adapter.launch(apps[0]);
  assert.deepEqual(calls.at(-1), ["/opt/codex", []]);
});

for (const platform of ["darwin", "win32"]) test(`${platform} adapter uses discovered identity and normal-close platform command`, async () => {
  const calls = [];
  const app = { pid: 123, identity: "123:456:verified", label: "Codex", location: platform === "darwin" ? "/Applications/Codex.app" : "C:\\Codex\\Codex.exe", executable: platform === "darwin" ? "/Applications/Codex.app/Contents/MacOS/Codex" : "C:\\Codex\\Codex.exe", closeSupported: true };
  const adapter = nativeAdapter(platform, { command: async (...args) => { calls.push(args); return JSON.stringify([app]); }, relaunch: async (...args) => calls.push(args) });
  assert.deepEqual(await adapter.discover(), [app]);
  await adapter.close(app);
  const close = calls.at(-1);
  if (platform === "darwin") { assert.equal(close[0], "/usr/bin/osascript"); assert.equal(close[1].at(-1), app.identity); assert.match(close[1][3], /app\.terminate/); }
  else { assert.equal(close[2].CGW_RESTART_IDENTITY, app.identity); assert.match(close[1].at(-1), /CloseMainWindow/); }
  await adapter.launch(app);
  assert.deepEqual(calls.at(-1), platform === "darwin" ? ["/usr/bin/open", ["-a", app.location]] : [app.executable, []]);
});
