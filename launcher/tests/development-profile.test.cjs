const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  defaultDevelopmentHome, validateDevelopmentHome, developmentLaunchEnvironment,
  developmentDesktopEntry, installLinuxDevelopmentShortcut,
} = require("../electron/development-profile.cjs");

test("DEV launch keeps a separate home and clears inherited production authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-dev-profile-"));
  try {
    const production = path.join(root, "production");
    const codex = path.join(root, "codex");
    const dev = path.join(root, "development");
    fs.mkdirSync(dev);
    assert.equal(validateDevelopmentHome(dev, [production, codex]), dev);
    assert.throws(() => validateDevelopmentHome(production, [production, codex]), /separate/);
    assert.throws(() => validateDevelopmentHome(root, [production, codex]), /separate/);
    assert.throws(() => validateDevelopmentHome(path.join(production, "child"), [production, codex]), /separate/);
    const alias = path.join(root, "alias");
    fs.symlinkSync(dev, alias);
    assert.equal(validateDevelopmentHome(alias, [production, codex]), dev);
    assert.equal(defaultDevelopmentHome(root), path.join(root, ".codex-chatgpt-web-dev"));
    const env = developmentLaunchEnvironment({ PATH: "/bin", CODEX_HOME: codex, CODEX_CHATGPT_WEB_HOME: production, CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID: "private", OPENAI_API_KEY: "secret" }, dev);
    assert.equal(env.CODEX_WEB_GPT_DEV_HOME, dev);
    assert.equal(env.PATH, "/bin");
    for (const key of ["CODEX_HOME", "CODEX_CHATGPT_WEB_HOME", "CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID", "OPENAI_API_KEY"]) assert.equal(env[key], undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Linux DEV shortcut is distinct and preserves a contributor-managed entry", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-dev-shortcut-"));
  try {
    const executable = path.join(root, "codex-web-gpt");
    fs.writeFileSync(executable, "binary", { mode: 0o700 });
    fs.writeFileSync(path.join(root, "codex-web-gpt.png"), "icon");
    const home = path.join(root, "dev profile");
    const target = path.join(root, "applications", "codex-web-gpt-dev.desktop");
    assert.equal(installLinuxDevelopmentShortcut({ home, executable, dataHome: root }), "installed");
    const content = fs.readFileSync(target, "utf8");
    assert.equal(content, developmentDesktopEntry(home, executable));
    assert.match(content, /--dev-profile/);
    assert.match(content, /CODEX_WEB_GPT_DEV_HOME=/);
    assert.ok(content.includes(`Icon=${path.join(root, "codex-web-gpt.png")}\n`));
    assert.match(developmentDesktopEntry(home, path.join(root, "portable", "portable.AppImage")), /\nIcon=codex-web-gpt\n/);
    assert.equal(installLinuxDevelopmentShortcut({ home, executable, dataHome: root }), "present");
    fs.writeFileSync(target, "[Desktop Entry]\nName=Contributor DEV\n");
    assert.equal(installLinuxDevelopmentShortcut({ home, executable, dataHome: root }), "existing-unmanaged");
    assert.equal(fs.readFileSync(target, "utf8"), "[Desktop Entry]\nName=Contributor DEV\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
