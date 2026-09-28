const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function patchedListenerHooks() {
  const preload = fs.readFileSync(require.resolve("electron-chrome-extensions/preload"), "utf8");
  const start = preload.indexOf("  var formatIpcName = ");
  const end = preload.indexOf("  // src/renderer/index.ts", start);
  assert.ok(start >= 0 && end > start, "Patched extension listener bridge is unavailable");
  const ipcRenderer = new EventEmitter();
  const subscriptions = [];
  ipcRenderer.send = (...args) => subscriptions.push(args);
  const context = { import_electron: { ipcRenderer }, subscriptions };
  vm.runInNewContext(`${preload.slice(start, end)}\nthis.hooks = { addExtensionListener, removeExtensionListener };`, context);
  return { ...context.hooks, ipcRenderer, subscriptions };
}

test("extension event listeners release their exact IPC wrapper across repeated cycles", () => {
  const { addExtensionListener, removeExtensionListener, ipcRenderer, subscriptions } = patchedListenerHooks();
  let calls = 0;
  const callback = () => { calls += 1; };
  for (let index = 0; index < 1_000; index += 1) {
    addExtensionListener("provider-a", "tabs.onUpdated", callback);
    addExtensionListener("provider-a", "tabs.onUpdated", callback);
    assert.equal(ipcRenderer.listenerCount("crx-tabs.onUpdated"), 1);
    ipcRenderer.emit("crx-tabs.onUpdated", {}, index);
    removeExtensionListener("provider-a", "tabs.onUpdated", callback);
    assert.equal(ipcRenderer.listenerCount("crx-tabs.onUpdated"), 0);
  }
  assert.equal(calls, 1_000);
  assert.equal(subscriptions.filter(([name]) => name === "crx-add-listener").length, 1_000);
  assert.equal(subscriptions.filter(([name]) => name === "crx-remove-listener").length, 1_000);
});

test("extension subscriptions with the same event name remain independently owned", () => {
  const { addExtensionListener, removeExtensionListener, ipcRenderer, subscriptions } = patchedListenerHooks();
  const a = () => {}, b = () => {};
  addExtensionListener("provider-a", "tabs.onUpdated", a);
  addExtensionListener("provider-b", "tabs.onUpdated", b);
  assert.equal(ipcRenderer.listenerCount("crx-tabs.onUpdated"), 2);
  removeExtensionListener("provider-a", "tabs.onUpdated", a);
  assert.equal(ipcRenderer.listenerCount("crx-tabs.onUpdated"), 1);
  assert.deepEqual(Array.from(subscriptions.at(-1)), ["crx-remove-listener", "provider-a", "tabs.onUpdated"]);
  removeExtensionListener("provider-b", "tabs.onUpdated", b);
  assert.equal(ipcRenderer.listenerCount("crx-tabs.onUpdated"), 0);
});
