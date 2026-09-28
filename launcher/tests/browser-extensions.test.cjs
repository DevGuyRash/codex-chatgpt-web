const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

function extensionFixture({ failLoad = false, isDevelopment = false } = {}) {
  const filename = path.resolve(__dirname, "../electron/browser-extensions.cjs");
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const tabs = new Set();
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = { session: options.webPreferences.session, isDestroyed: () => this.destroyed, setWindowOpenHandler() {} };
      this.destroyed = false;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    getBounds() { return { x: 0, y: 0, width: 920, height: 720 }; }
    setBounds() {}
    show() {}
    focus() {}
    async loadURL() { if (failLoad) throw new Error("Extension document failed to load"); }
    close() { this.emit("close"); this.destroy(); }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); }
  }
  class Adapter extends EventEmitter {
    addTab(contents) { tabs.add(contents); }
    removeTab(contents) { tabs.delete(contents); }
  }
  const browserSession = { getPreloadScripts: () => [], registerPreloadScript() {} };
  const fixtureRequire = name => {
      if (name === "electron") return { BrowserWindow, nativeImage: { createFromPath: source => ({ isEmpty: () => false, resize: () => ({ isEmpty: () => false, source }) }) } };
      if (name === "electron-chrome-extensions") return { ElectronChromeExtensions: Adapter };
      if (name === "electron-chrome-web-store") return { downloadExtension() {} };
      if (name === "./window-placement.cjs") return { placeWindowNearLauncher() {} };
      return nativeRequire(name);
  };
  fixtureRequire.resolve = name => name === "electron-chrome-extensions/preload" ? filename : nativeRequire.resolve(name);
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: fixtureRequire,
    module, URL, setInterval, clearInterval, setTimeout, clearTimeout,
  }, { filename });
  const extensions = new module.exports.BrowserExtensions({
    browserSession, userData: "/tmp/extension-lifecycle-fixture", logger: { info() {}, warn() {} }, isDevelopment,
  });
  return { extensions, browserSession, tabs, windows };
}

test("force-closing an extension window releases its registered tab", async () => {
  const { extensions, tabs, windows } = extensionFixture();
  await extensions.createWindow({ url: "https://example.com/" });
  assert.equal(tabs.size, 1);
  windows[0].destroy();
  assert.equal(tabs.size, 0);
  assert.equal(extensions.pages.size, 0);
  extensions.destroy();
});

test("failed extension navigation cannot retain a window or tab", async () => {
  const { extensions, tabs, windows } = extensionFixture({ failLoad: true });
  await assert.rejects(extensions.createWindow({ url: "https://example.com/" }), /failed to load/);
  assert.equal(windows[0].isDestroyed(), true);
  assert.equal(tabs.size, 0);
  assert.equal(extensions.pages.size, 0);
  extensions.destroy();
});

test("DEV extension windows use the distinct native icon", async () => {
  const { extensions, windows } = extensionFixture({ isDevelopment: true });
  await extensions.createWindow();
  assert.match(windows[0].options.icon.source, /dev-icon\.png$/);
  extensions.destroy();
});

test("pausing an installed provider unloads it for this session and resume validates its identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-pause-fixture-"));
  const id = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  const extensionPath = path.join(root, id, "8.12.37.1_0");
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, "manifest.json"), JSON.stringify({ manifest_version: 3, permissions: [], version: "8.12.37.1" }));
  const { extensions, browserSession } = extensionFixture();
  let removes = 0, loads = 0;
  browserSession.extensions = {
    removeExtension(value) { assert.equal(value, id); removes++; },
    async loadExtension(value) { assert.equal(value, extensionPath); loads++; return { id, path: value, version: "8.12.37.1", manifest: { action: { default_popup: "popup.html" } } }; },
  };
  extensions.loaded.set(id, { id, path: extensionPath, version: "8.12.37.1", manifest: { action: { default_popup: "popup.html" } } });
  try {
    const paused = extensions.pause(id).providers.find(provider => provider.id === id);
    assert.deepEqual({ installed: paused.installed, active: paused.active, version: paused.version }, { installed: true, active: false, version: "8.12.37.1" });
    assert.equal(extensions.status().active, false);
    assert.equal(removes, 1);
    const resumed = (await extensions.resume(id)).providers.find(provider => provider.id === id);
    assert.deepEqual({ installed: resumed.installed, active: resumed.active }, { installed: true, active: true });
    assert.equal(loads, 1);
    await extensions.createWindow({ url: "https://example.com/" });
    assert.throws(() => extensions.pause(id), /Close extension windows/);
    assert.equal(extensions.status().active, true);
  } finally { extensions.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("opening a paused provider resumes its reviewed worker before showing its popup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "extension-open-paused-"));
  const id = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  const extensionPath = path.join(root, id, "8.12.37.1_0");
  fs.mkdirSync(extensionPath, { recursive: true });
  fs.writeFileSync(path.join(extensionPath, "manifest.json"), JSON.stringify({ manifest_version: 3, permissions: [], version: "8.12.37.1" }));
  const { extensions, browserSession, windows } = extensionFixture();
  let loads = 0;
  browserSession.extensions = {
    removeExtension() {},
    async loadExtension(value) { loads++; return { id, path: value, version: "8.12.37.1", manifest: { action: { default_popup: "popup.html" } } }; },
  };
  extensions.loaded.set(id, { id, path: extensionPath, version: "8.12.37.1", manifest: { action: { default_popup: "popup.html" } } });
  try {
    extensions.pause(id);
    await extensions.open(id);
    assert.equal(loads, 1);
    assert.equal(extensions.status().active, true);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].isDestroyed(), false);
  } finally { extensions.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
