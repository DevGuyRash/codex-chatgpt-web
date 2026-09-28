const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

function routerFixture() {
  const bundle = fs.readFileSync(require.resolve("electron-chrome-extensions"), "utf8");
  const start = bundle.indexOf("var getHostId = ");
  const end = bundle.indexOf("// src/browser/license.ts", start);
  assert.ok(start >= 0 && end > start, "Patched extension router is unavailable");
  const app = new EventEmitter();
  const session = { extensions: new EventEmitter(), serviceWorkers: new EventEmitter() };
  const context = { import_electron9: { app }, RoutingDelegate: { get: () => ({ addObserver() {} }) }, d8() {} };
  vm.runInNewContext(`${bundle.slice(start, end)}\nthis.ExtensionRouter = ExtensionRouter;`, context);
  return { router: new context.ExtensionRouter(session), app, session };
}

test("unloading one extension releases only its worker and background host references", () => {
  const { router, app, session } = routerFixture();
  const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", second = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const workerA = { scope: `chrome-extension://${first}/`, versionId: 1 };
  const workerB = { scope: `chrome-extension://${second}/`, versionId: 2 };
  router.extensionWorkers.add(workerA);
  router.extensionWorkers.add(workerB);
  const host = new EventEmitter();
  host.session = session;
  host.getType = () => "backgroundPage";
  host.getURL = () => `chrome-extension://${first}/background.html`;
  host.isDestroyed = () => false;
  app.emit("web-contents-created", {}, host);
  assert.equal(router.extensionHosts.size, 1);
  session.extensions.emit("extension-unloaded", {}, { id: first });
  assert.equal(router.extensionWorkers.has(workerA), false);
  assert.equal(router.extensionWorkers.has(workerB), true);
  assert.equal(router.extensionHosts.size, 0);
});

test("a destroyed background host does not remain pinned by the router", () => {
  const { router, app, session } = routerFixture();
  const host = new EventEmitter();
  host.session = session;
  host.getType = () => "backgroundPage";
  app.emit("web-contents-created", {}, host);
  assert.equal(router.extensionHosts.size, 1);
  host.emit("destroyed");
  assert.equal(router.extensionHosts.size, 0);
});
