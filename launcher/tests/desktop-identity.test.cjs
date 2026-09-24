const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { launcherIconPath, launcherWindowIcon, desktopNameForProfile } = require("../electron/desktop-identity.cjs");

test("normal and DEV profiles have distinct desktop identities", () => {
  assert.equal(desktopNameForProfile(false), "codex-web-gpt.desktop");
  assert.equal(desktopNameForProfile(true), "codex-web-gpt-dev.desktop");
});

test("native window icon is decoded once at taskbar size per runtime", () => {
  const calls = [];
  const windowIcon = { isEmpty: () => false };
  const decoder = { createFromPath: file => {
    calls.push(file);
    return { isEmpty: () => false, resize: size => {
      assert.deepEqual(size, { width: 128, height: 128 });
      return windowIcon;
    } };
  } };
  assert.equal(launcherWindowIcon(decoder, { packaged: false }), windowIcon);
  assert.equal(launcherWindowIcon(decoder, { packaged: false }), windowIcon);
  assert.deepEqual(calls, [launcherIconPath({ packaged: false })]);
  assert.throws(() => launcherWindowIcon({ createFromPath: () => ({ isEmpty: () => true }) }, { packaged: false }), /could not be decoded/);
});

test("DEV uses a distinct icon asset", () => {
  const normal = launcherIconPath({ packaged: false });
  const development = launcherIconPath({ packaged: false, isDevelopment: true });
  assert.notEqual(development, normal);
  assert.equal(fs.readFileSync(development).equals(fs.readFileSync(normal)), false);
});
