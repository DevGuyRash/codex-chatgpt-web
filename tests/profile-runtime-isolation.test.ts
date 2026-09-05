import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { installCodexIntegration, setCodexSubagentProtocol } from "../src/codex-integration";
import { resolveIntegrationTarget, integrationConnectorNames } from "../src/codex-integration-target";
import { profileModelCatalogPath } from "../src/profile-model-catalog";
import { getCodexJournalPath } from "../src/codex-integration-shared";
import { RuntimeRegistry } from "../launcher/electron/runtime-registry.cjs";
import { profileNativeCatalogFixture, unitProfileCapabilityFixture } from "./fixtures/profile-integration";

test("Native and Compatibility V1 child runtimes coexist; stopping and changing one leaves its peer unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-profile-processes-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const base = "# unintegrated native base\n[features]\nmulti_agent_v2=true\n";
    writeFileSync(join(codexHome, "config.toml"), base);
    writeFileSync(join(codexHome, "models_cache.json"), profileNativeCatalogFixture);
    const registry = new RuntimeRegistry({ runtimeRoot: join(root, "runtime") });
    const targets = ["native", "compatibility"].map(profile => resolveIntegrationTarget({ codexHome, runtimeRoot: registry.runtimeRoot, profile }));
    const reservations = await Promise.all(targets.map(target => registry.ensure(target)));
    const configs = targets.map((target, index) => {
      unitProfileCapabilityFixture(target, root);
      const names = integrationConnectorNames(target);
      const config = { ...defaultConfig("browser-only", target.runtimeHome), integrationTarget: target, subagentProtocol: index === 0 ? "native" as const : "compatibility-v1" as const, port: reservations[index]!.port, appName: names.automatic, automaticAppName: names.automatic, manualAppName: names.manual };
      saveConfig(config);
      installCodexIntegration(config);
      return config;
    });
    const start = (index: number) => {
      const child = Bun.spawn([process.execPath, process.env.CODEX_TEST_PROFILE_RUNTIME_CLI ?? resolve("src/cli.ts"), "--home", registry.runtimeRoot, "--codex-home", codexHome, "--codex-profile", targets[index]!.profile!, "serve"], {
        env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "wrong-ambient-home") }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      children.push(child);
      return child;
    };
    const health = async (index: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const result = await fetch(`http://127.0.0.1:${configs[index]!.port}/healthz`, { signal: AbortSignal.timeout(500) }); if (result.ok) return await result.json() as { pid: number; profile_model_catalog: { ready: boolean } }; } catch { /* Wait for this owned child to bind. */ }
        await Bun.sleep(30);
      }
      throw new Error("Isolated runtime did not become ready");
    };
    const a = start(0);
    const b = start(1);
    const [first, peer] = await Promise.all([health(0), health(1)]);
    expect(first.pid).toBe(a.pid);
    expect(peer.pid).toBe(b.pid);
    expect(first.profile_model_catalog.ready).toBe(true);
    expect(peer.profile_model_catalog.ready).toBe(true);
    expect(configs[0]!.appName).not.toBe(configs[1]!.appName);
    expect(configs[0]!.manualAppName).not.toBe(configs[1]!.manualAppName);
    const peerPaths = [targets[1]!.configPath, getCodexJournalPath(targets[1]!), profileModelCatalogPath(targets[1]!), join(targets[1]!.runtimeHome, "config.json")];
    const bytes = peerPaths.map(path => readFileSync(path, "utf8"));
    a.kill("SIGTERM");
    await a.exited;
    setCodexSubagentProtocol(configs[0]!, "compatibility-v1");
    expect((await health(1)).pid).toBe(b.pid);
    expect(peerPaths.map(path => readFileSync(path, "utf8"))).toEqual(bytes);
    b.kill("SIGTERM");
    await b.exited;
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(base);
    expect(readFileSync(join(codexHome, "models_cache.json"), "utf8")).toBe(profileNativeCatalogFixture);
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
