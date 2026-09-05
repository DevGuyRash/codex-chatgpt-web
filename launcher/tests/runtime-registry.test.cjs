const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { RuntimeRegistry } = require("../electron/runtime-registry.cjs");
const { resolveIntegrationTarget } = require("../electron/integration-target.cjs");

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
