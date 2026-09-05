const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { registerLoggedIpc } = require("../electron/logging.cjs");

test("repair preload arguments reach the registered main handlers without the Electron event", async () => {
  const handlers = new Map();
  const calls = [];
  const main = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit("));
  const state = { codexRestartRequired: true };
  const context = {
    registerLoggedIpc,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    runtimeHost: {
      previewIntegrationRepair: async protocol => { assert.equal(protocol, "native"); calls.push(["preview", protocol]); return { protocol }; },
      applyIntegrationRepair: async (protocol, approvalId) => { assert.equal(protocol, "native"); assert.equal(approvalId, "approved-preview"); calls.push(["apply", protocol, approvalId]); },
    },
    send: () => {}, stopCatalogVerificationMonitor: () => {},
  };
  vm.runInNewContext(`${registration}\nregisterIpc({ logger: { error() {} }, stateStore: { update() { return state; } } });`, { ...context, state });
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve("../electron/preload.cjs"), "utf8"), {
    require: name => { assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({ sender: {} }, ...args) },
    }; },
  });
  assert.equal((await api.previewIntegrationRepair("native")).protocol, "native");
  assert.equal((await api.applyIntegrationRepair("native", "approved-preview")).state, state);
  assert.deepEqual(calls, [["preview", "native"], ["apply", "native", "approved-preview"]]);
});
