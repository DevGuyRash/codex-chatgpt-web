import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationLaunch, listIntegrationTargets, resolveIntegrationTarget } from "../src/codex-integration-target";
import { getCodexConfigPath, getCodexJournalPath } from "../src/codex-integration-shared";
import { defaultConfig, getConfigPath, loadConfig, saveConfig } from "../src/config";
import { activateCodexIntegration, deactivateCodexIntegration, installCodexIntegration, inspectCodexIntegration, uninstallCodexIntegration } from "../src/codex-integration";
import { unitProfileCapabilityFixture, profileNativeCatalogFixture } from "./fixtures/profile-integration";
import { profileModelCatalogPath, refreshProfileModelCatalog } from "../src/profile-model-catalog";
import { runtimeServiceLabel } from "../src/runtime-service-label";

test("profile catalog refresh follows current native metadata and layered context without touching shared files", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-catalog-refresh-"));
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "model_context_window=1234567\n");
    writeFileSync(join(codexHome, "models_cache.json"), profileNativeCatalogFixture);
    const target = resolveIntegrationTarget({ codexHome, runtimeRoot: join(root, "runtime"), profile: "native" });
    unitProfileCapabilityFixture(target, root);
    const config = { ...defaultConfig("browser-only", target.runtimeHome), integrationTarget: target, port: 18021 };
    saveConfig(config);
    installCodexIntegration(config, { target });
    const catalog = () => JSON.parse(readFileSync(profileModelCatalogPath(target), "utf8"));
    expect(catalog().models[0].max_context_window).toBe(1234567);
    expect(refreshProfileModelCatalog(config)).toBe(false);
    const source = JSON.parse(profileNativeCatalogFixture);
    source.models[0].display_name = "Changed native metadata";
    const bytes = JSON.stringify(source);
    writeFileSync(join(codexHome, "models_cache.json"), bytes);
    writeFileSync(target.configPath, `model_context_window=2345678\n${readFileSync(target.configPath, "utf8")}`);
    expect(refreshProfileModelCatalog(config)).toBe(true);
    expect(catalog().models[0].display_name).toBe("Changed native metadata");
    expect(catalog().models[0].max_context_window).toBe(2345678);
    expect(readFileSync(join(codexHome, "models_cache.json"), "utf8")).toBe(bytes);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("model_context_window=1234567\n");
    source.models.push({ ...source.models[0], slug: "chatgpt-web/high" });
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify(source));
    // This unit binary intentionally cannot execute. An augmented cache must require genuine
    // native metadata instead of inheriting a peer bridge's protocol mutation as native truth.
    expect(() => refreshProfileModelCatalog(config)).toThrow("native model metadata is unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("independent target paths do not depend on process environment retargeting", () => {
  const options = { codexHome: "/tmp/cgw-target-codex", runtimeRoot: "/tmp/cgw-target-runtime" };
  const a = resolveIntegrationTarget({ ...options, profile: "native" });
  const b = resolveIntegrationTarget({ ...options, profile: "compatibility" });
  expect(a.id).not.toBe(b.id);
  expect(a.runtimeHome).not.toBe(b.runtimeHome);
  expect(runtimeServiceLabel("daemon", a.runtimeHome)).not.toBe(runtimeServiceLabel("daemon", b.runtimeHome));
  expect(runtimeServiceLabel("daemon", options.runtimeRoot)).toBe("daemon");
  expect(getCodexConfigPath(a)).toBe(a.configPath);
  expect(getCodexJournalPath(a)).toBe(join(a.runtimeHome, "codex", "integration-journal.json"));
  expect(getCodexJournalPath(b)).not.toBe(getCodexJournalPath(a));
  expect(integrationLaunch(a)).toEqual({ executable: "codex", args: ["--profile", "native"], env: { CODEX_HOME: a.codexHome } });
});

test("target discovery is read-only and rejects path traversal and source aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-targets-"));
  try {
    mkdirSync(join(root, "codex"));
    writeFileSync(join(root, "codex", "config.toml"), "");
    writeFileSync(join(root, "codex", "work.config.toml"), "");
    const options = { codexHome: join(root, "codex"), runtimeRoot: join(root, "runtime") };
    expect(listIntegrationTargets(options).map(target => target.profile ?? "base")).toEqual(["base", "work"]);
    expect(() => resolveIntegrationTarget({ ...options, profile: "../escape" })).toThrow("profile names");
    if (process.platform !== "win32") {
      symlinkSync(join(root, "codex", "config.toml"), join(root, "codex", "alias.config.toml"));
      expect(() => resolveIntegrationTarget({ ...options, profile: "alias" })).toThrow("aliases");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime configuration cannot redirect its owning target to a different home", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-target-validation-"));
  try {
    const target = resolveIntegrationTarget({ codexHome: join(root, "codex"), runtimeRoot: join(root, "runtime"), profile: "work" });
    const config = { ...defaultConfig("browser-only", target.runtimeHome), integrationTarget: target };
    saveConfig(config);
    expect(loadConfig(target.runtimeHome).integrationTarget).toEqual(target);
    writeFileSync(getConfigPath(target.runtimeHome), JSON.stringify({ ...config, integrationTarget: { ...target, runtimeHome: join(root, "victim") } }));
    expect(() => loadConfig(target.runtimeHome)).toThrow("target");
    expect(() => saveConfig({ ...config, integrationTarget: { ...target, configPath: join(root, "victim.toml") } })).toThrow("target");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("profile install, disconnect, reconnect and removal preserve peer and base bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-target-lifecycle-"));
  try {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const base = '[features]\nmulti_agent_v2=true\n';
    writeFileSync(join(codexHome, "config.toml"), base);
    writeFileSync(join(codexHome, "models_cache.json"), profileNativeCatalogFixture);
    const a = resolveIntegrationTarget({ codexHome, runtimeRoot: join(root, "runtime"), profile: "native" });
    const b = resolveIntegrationTarget({ codexHome, runtimeRoot: join(root, "runtime"), profile: "compat" });
    for (const [target, protocol, port] of [[a, "native", 18001], [b, "compatibility-v1", 18002]] as const) {
      const config = { ...defaultConfig("browser-only", target.runtimeHome), integrationTarget: target, subagentProtocol: protocol, port };
      unitProfileCapabilityFixture(target, root);
      saveConfig(config);
      installCodexIntegration(config, { target });
      expect(inspectCodexIntegration({ target, readOnly: true }).errors).toEqual([]);
    }
    const peerPaths = [b.configPath, getCodexJournalPath(b), profileModelCatalogPath(b)];
    const peer = peerPaths.map(path => readFileSync(path, "utf8"));
    deactivateCodexIntegration(a);
    activateCodexIntegration(a);
    uninstallCodexIntegration(a);
    expect(peerPaths.map(path => readFileSync(path, "utf8"))).toEqual(peer);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(base);
    expect(readFileSync(join(codexHome, "models_cache.json"), "utf8")).toBe(profileNativeCatalogFixture);
    expect(inspectCodexIntegration({ target: b, readOnly: true }).errors).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
