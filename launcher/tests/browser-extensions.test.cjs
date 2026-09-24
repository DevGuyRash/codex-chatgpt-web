const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function extensionFixture({ failLoad = false } = {}) {
  const filename = path.resolve(__dirname, "../electron/browser-extensions.cjs");
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const tabs = new Set();
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
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
      if (name === "electron") return { BrowserWindow };
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
    browserSession, userData: "/tmp/extension-lifecycle-fixture", logger: { info() {}, warn() {} },
  });
  return { extensions, tabs, windows };
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
