const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { registerLoggedIpc, registerDiagnosticsIpc } = require("../electron/logging.cjs");
const { ConfigurationReview } = require("../electron/configuration-review.cjs");

test("profile migration uses the existing setup IPC owner and preserves its explicit migration option", async () => {
  const handlers = new Map();
  const calls = [];
  const events = [];
  let failSetup = false;
  const main = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit("));
  const stateStore = { read: () => ({ browserInteractionMode: "manual" }), update() {} };
  vm.runInNewContext(`${registration}\nregisterIpc({ logger: { error() {}, warn() {} }, stateStore });`, {
    stateStore, IS_DEV_PROFILE: false, IS_CODEX_PROFILE: true, registerLoggedIpc, registerDiagnosticsIpc, runtimeSupervisor: null,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} }, publishOperation() {},
    runtimeHost: { setupCore: async options => { if (failSetup) throw new Error("Setup cancelled"); calls.push(JSON.parse(JSON.stringify(options))); return { mode: "browser-only", stdout: "" }; }, runtimeConfigSnapshot: () => ({ config: {} }) },
    send: name => events.push(name),
    browserHost: { returnToIdle: async () => {} }, startCatalogVerificationMonitor() {},
  });
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve("../electron/generated/preload.cjs"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({}, ...args) } }),
  });
  await api.setupCore({ migrateBase: true });
  assert.deepEqual(calls, [{ migrateBase: true }]);
  assert.deepEqual(events, ["launcher:codex-restart-required"]);
  failSetup = true;
  await assert.rejects(api.setupCore(), /Setup cancelled/);
  assert.deepEqual(events, ["launcher:codex-restart-required"]);
  await assert.rejects(api.setupCore({ migrateBase: "yes" }), /Unsupported setup/);
});

test("repair preload arguments reach the registered main handlers without the Electron event", async () => {
  const handlers = new Map();
  const calls = [];
  const operations = [];
  const main = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit("));
  const state = { codexRestartRequired: true };
  const context = {
    configurationReview: new ConfigurationReview({ publish() {} }),
    registerLoggedIpc, registerDiagnosticsIpc, runtimeSupervisor: null,
    publishOperation: operation => operations.push(operation),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    runtimeHost: {
      previewIntegrationRepair: async protocol => { assert.equal(protocol, "native"); calls.push(["preview", protocol]); return { protocol }; },
      applyIntegrationRepair: async (protocol, approvalId) => { assert.equal(protocol, "native"); assert.equal(approvalId, "approved-preview"); calls.push(["apply", protocol, approvalId]); },
    },
    send: () => {}, stopCatalogVerificationMonitor: () => {},
  };
  vm.runInNewContext(`${registration}\nregisterIpc({ logger: { error() {} }, stateStore: { update() { return state; } } });`, { ...context, state });
  let api;
  vm.runInNewContext(fs.readFileSync(require.resolve("../electron/generated/preload.cjs"), "utf8"), {
    require: name => { assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({ sender: {} }, ...args) },
    }; },
  });
  assert.equal((await api.previewIntegrationRepair("native")).protocol, "native");
  assert.equal((await api.applyIntegrationRepair("native", "approved-preview")).state, state);
  assert.deepEqual(calls, [["preview", "native"], ["apply", "native", "approved-preview"]]);
  const pending = context.configurationReview.request({ approvalId: "current", status: "ready" });
  await api.decideConfiguration("current", true);
  assert.equal(await pending, "current");
  assert.equal(context.configurationReview.snapshot(), null);
  const problem = { code: "codex_configuration_conflict", message: "Configuration differs", findings: [], actions: ["review-configuration"] };
  context.runtimeHost.previewIntegrationRepair = async () => { throw Object.assign(new Error(problem.message), { problem }); };
  await assert.rejects(api.previewIntegrationRepair("native"), /Configuration differs/);
  assert.equal(operations.at(-1).problem, problem);
});
