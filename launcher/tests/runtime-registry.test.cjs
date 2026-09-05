const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { RuntimeRegistry } = require("../electron/runtime-registry.cjs");
const { resolveIntegrationTarget } = require("../electron/integration-target.cjs");

test("listing targets preserves the base and normal profiles when another profile is linked or broken", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-registry-links-"));
  try {
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "config.toml"), "# base\n");
    fs.writeFileSync(path.join(codexHome, "work.config.toml"), "# work\n");
    const external = path.join(root, "external.toml");
    fs.writeFileSync(external, "# managed elsewhere\n");
    try {
      fs.symlinkSync(external, path.join(codexHome, "linked.config.toml"));
      fs.symlinkSync(path.join(root, "missing.toml"), path.join(codexHome, "broken.config.toml"));
    } catch (error) { if (process.platform === "win32" && error.code === "EPERM") { context.skip("File symlinks require Windows developer mode or privileges"); return; } throw error; }
    const registry = new RuntimeRegistry({ runtimeRoot: path.join(root, "runtime") });
    assert.deepEqual(registry.list(codexHome).map(target => target.profile ?? "base"), ["base", "work"]);
    const discovered = registry.discover(codexHome);
    assert.equal(discovered.entries.find(entry => entry.profile === "linked").status, "external");
    assert.equal(discovered.entries.find(entry => entry.profile === "linked").resolvedPath, external);
    assert.equal(discovered.entries.find(entry => entry.profile === "broken").status, "unavailable");
    assert.throws(() => resolveIntegrationTarget({ codexHome, runtimeRoot: registry.runtimeRoot, profile: "broken" }), /aliases/);
    assert.equal(fs.lstatSync(path.join(codexHome, "linked.config.toml")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(external, "utf8"), "# managed elsewhere\n");
    assert.equal(fs.existsSync(registry.runtimeRoot), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reservation excludes an idle base runtime's custom port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-registry-base-"));
  try {
    const registry = new RuntimeRegistry({ runtimeRoot: path.join(root, "runtime") });
    const target = resolveIntegrationTarget({ codexHome: path.join(root, "codex"), runtimeRoot: registry.runtimeRoot, profile: "work" });
    const preferred = 18000 + parseInt(target.id.slice(-4), 16) % 40000;
    fs.mkdirSync(registry.runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(registry.runtimeRoot, "config.json"), JSON.stringify({ port: preferred }));
    assert.notEqual((await registry.ensure(target)).port, preferred);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("discovery keeps file targets and reports corrupt optional registry records without rewriting them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-registry-partial-"));
  try {
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "work.config.toml"), "# existing profile\n");
    const registry = new RuntimeRegistry({ runtimeRoot: path.join(root, "runtime") });
    fs.mkdirSync(path.dirname(registry.path), { recursive: true });
    const target = resolveIntegrationTarget({ codexHome, runtimeRoot: registry.runtimeRoot, profile: "work" });
    const invalid = JSON.stringify({ version: 1, targets: [{ target, port: "invalid" }] });
    fs.writeFileSync(registry.path, invalid);
    const discovered = registry.discover(codexHome);
    assert.equal(discovered.entries.filter(entry => entry.status === "available").length, 2);
    assert.equal(discovered.issues[0].code, "target_registry_entry_unavailable");
    assert.equal(fs.readFileSync(registry.path, "utf8"), invalid);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("concurrent profile registration reserves distinct stable endpoints without changing Codex sources", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-registry-"));
  try {
    const codexHome = path.join(root, "codex");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "config.toml"), "native sentinel");
    const registry = new RuntimeRegistry({ runtimeRoot: path.join(root, "runtime") });
    const a = resolveIntegrationTarget({ codexHome, runtimeRoot: registry.runtimeRoot, profile: "native" });
    const b = resolveIntegrationTarget({ codexHome, runtimeRoot: registry.runtimeRoot, profile: "compatibility" });
    const [first, second] = await Promise.all([registry.ensure(a), new RuntimeRegistry({ runtimeRoot: registry.runtimeRoot }).ensure(b)]);
    assert.notEqual(first.port, second.port);
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(first.port, "127.0.0.1", resolve); });
    try { assert.equal((await registry.ensure(a)).port, first.port, "an occupied reserved endpoint is never silently reassigned"); }
    finally { await new Promise(resolve => listener.close(resolve)); }
    assert.equal(registry.list(codexHome).length, 3);
    assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), "native sentinel");
    assert.equal(fs.existsSync(a.configPath), false);
    assert.equal(fs.existsSync(b.configPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
