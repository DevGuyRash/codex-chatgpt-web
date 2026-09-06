const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { RuntimeRegistry } = require("../electron/runtime-registry.cjs");
const { resolveIntegrationTarget } = require("../electron/integration-target.cjs");
const { registerLoggedIpc, registerDiagnosticsIpc } = require("../electron/logging.cjs");

test("target selection and native capability picker cross real preload/main IPC with isolated spawn authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-target-ipc-"));
  try {
    const registry = new RuntimeRegistry({ runtimeRoot: path.join(root, "runtime") });
    const selected = resolveIntegrationTarget({ codexHome: path.join(root, "codex"), runtimeRoot: registry.runtimeRoot, profile: "native" });
    const handlers = new Map();
    const launches = [];
    const checks = [];
    const main = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
    const registration = main.slice(main.indexOf("function registerIpc("), main.indexOf("async function requestQuit("));
    vm.runInNewContext(`${registration}\nregisterIpc({ logger: { error() {} }, stateStore: {} });`, {
      registerLoggedIpc, registerDiagnosticsIpc, resolveIntegrationTarget, runtimeRegistry: registry, IS_CODEX_PROFILE: true, runtimeSupervisor: null,
      LAUNCHER_PROFILE: { integrationTarget: selected, codexHome: selected.codexHome }, SOURCE_ROOT: root, path,
      app: { isPackaged: false }, mainWindow: {}, publishOperation() {},
      process: { execPath: "/absolute/electron", env: { CODEX_CHATGPT_WEB_HOME: selected.runtimeHome, CODEX_HOME: selected.codexHome, OPENAI_API_KEY: "unit-only", CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "unit-only", CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: "old-descriptor", ELECTRON_RUN_AS_NODE: "1" } },
      spawn(executable, args, options) { launches.push({ executable, args: [...args], env: { ...options.env } }); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/absolute/raw-codex"] }) },
      runtimeHost: { run: async (name, args) => { checks.push({ name, args: [...args] }); return { stdout: "{}" }; } },
    });
    let api;
    vm.runInNewContext(fs.readFileSync(require.resolve("../electron/generated/preload.cjs"), "utf8"), {
      require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { invoke: (name, ...args) => handlers.get(name)({}, ...args) } }),
    });
    const opened = await api.openIntegrationTarget({ codexHome: selected.codexHome, profile: "compatibility" });
    assert.equal(opened.target.profile, "compatibility");
    assert.equal(launches[0].env.CODEX_CHATGPT_WEB_HOME, registry.runtimeRoot);
    assert.deepEqual(launches[0].args.slice(-2), ["--codex-profile", "compatibility"]);
    for (const key of ["OPENAI_API_KEY", "CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN", "CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR", "ELECTRON_RUN_AS_NODE"]) assert.equal(launches[0].env[key], undefined);
    await api.checkTargetCapabilities();
    assert.deepEqual(checks.at(-1).args, ["targets", "check", "--codex-binary", "/absolute/raw-codex"]);
    assert.equal(registry.read().targets.length, 1);
    assert.equal(fs.existsSync(opened.target.configPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
