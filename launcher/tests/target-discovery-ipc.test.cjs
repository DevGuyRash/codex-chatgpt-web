const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

test("Settings IPC retains the current connection when inspection or enumeration fails", async () => {
  const source = readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const registration = source.slice(source.indexOf("function registerIpc("), source.indexOf("async function requestQuit("));
  for (const failDiscovery of [false, true]) {
    const handlers = new Map();
    const selected = { id: "current", codexHome: "/fixture", configPath: "/fixture/config.toml", kind: "base" };
    const external = { id: "external", status: "external", resolvedPath: "/managed/profile.toml" };
    runInNewContext(`${registration}\nregisterIpc({ logger: {}, stateStore: {} });`, {
      Error,
      registerDiagnosticsIpc: require("../electron/logging.cjs").registerDiagnosticsIpc, runtimeSupervisor: null,
      registerLoggedIpc: (ipcMain, _logger, name, callback) => ipcMain.handle(name, callback),
      ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {} },
      LAUNCHER_PROFILE: { integrationTarget: selected, codexHome: selected.codexHome },
      runtimeRegistry: { discover() { if (failDiscovery) throw new Error("Permission denied"); return { entries: [external], issues: [] }; } },
      runtimeHost: { run: async () => { throw new Error("Broken optional inspection"); } },
    });
    const result = await handlers.get("launcher:integration-targets")();
    assert.equal(result.selected, selected);
    assert.equal(result.selected.codexHome, "/fixture");
    assert.equal(result.inspectionError, "Broken optional inspection");
    if (failDiscovery) assert.equal(result.discovery.issues[0].code, "target_discovery_unavailable");
    else assert.equal(result.discovery.entries[0], external);
  }
});
