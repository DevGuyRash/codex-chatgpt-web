import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../src/config";
import { resolveIntegrationTarget } from "../src/codex-integration-target";
import { applyPreparedCodexIntegration, installCodexIntegration, prepareCodexIntegration } from "../src/codex-integration";
import { getCodexJournalPath } from "../src/codex-integration-shared";
import { previewSetupConfiguration } from "../src/setup";
import { profileNativeCatalogFixture, unitProfileCapabilityFixture } from "./fixtures/profile-integration";

function fixture(run: (context: ReturnType<typeof create>) => void) {
  const root = mkdtempSync(join(tmpdir(), "cgw-migrate-"));
  function create() {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const base = resolveIntegrationTarget({ codexHome, runtimeRoot: join(root, "runtime") });
    const profile = resolveIntegrationTarget({ codexHome, runtimeRoot: base.runtimeHome, profile: "work" });
    const original = '# user preference\n[features]\nmulti_agent_v2 = true\n';
    writeFileSync(base.configPath, original);
    const baseConfig = { ...defaultConfig("browser-only", base.runtimeHome), integrationTarget: base, subagentProtocol: "compatibility-v1" as const, port: 18271 };
    saveConfig(baseConfig);
    installCodexIntegration(baseConfig, { target: base });
    writeFileSync(join(codexHome, "models_cache.json"), profileNativeCatalogFixture);
    unitProfileCapabilityFixture(profile, root);
    const config = { ...defaultConfig("browser-only", profile.runtimeHome), integrationTarget: profile, subagentProtocol: "native" as const, port: 18272 };
    saveConfig(config);
    return { root, base, profile, original, config };
  }
  try { run(create()); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("migration is a combined read-only plan and archives original base restoration evidence", () => fixture(({ base, profile, original, config }) => {
  const before = readFileSync(base.configPath, "utf8");
  const journal = readFileSync(getCodexJournalPath(base), "utf8");
  expect(() => prepareCodexIntegration(config)).toThrow("inherits");
  const plan = prepareCodexIntegration(config, { migrateBase: true });
  expect(readFileSync(base.configPath, "utf8")).toBe(before);
  expect(existsSync(profile.configPath)).toBe(false);
  expect(plan.migration!.restored).toBe(original);
  applyPreparedCodexIntegration(plan);
  expect(readFileSync(base.configPath, "utf8")).toBe(original);
  expect(existsSync(getCodexJournalPath(base))).toBe(false);
  expect(readFileSync(join(plan.migration!.archive, "integration-journal.json"), "utf8")).toBe(journal);
  expect(readFileSync(profile.configPath, "utf8")).toContain("18272");
  expect(readFileSync(join(base.codexHome, "models_cache.json"), "utf8")).toBe(profileNativeCatalogFixture);
}));

for (const changed of ["base", "profile", "journal"] as const) test(`migration rejects intervening ${changed} edits without removing journals`, () => fixture(({ base, profile, config }) => {
  const plan = prepareCodexIntegration(config, { migrateBase: true });
  const path = changed === "base" ? base.configPath : changed === "profile" ? profile.configPath : getCodexJournalPath(base);
  const bytes = `${existsSync(path) ? readFileSync(path, "utf8") : ""}\n# external edit\n`;
  writeFileSync(path, bytes);
  expect(() => applyPreparedCodexIntegration(plan)).toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expect(existsSync(getCodexJournalPath(base))).toBe(true);
  expect(existsSync(join(plan.migration!.archive, "receipt.json"))).toBe(false);
}));

test("migration preserves changed user routing and exposes both targets in setup review", () => fixture(({ root, base, profile, config }) => {
  const before = readFileSync(base.configPath, "utf8").replace('openai_base_url = "http://127.0.0.1:18271/v1"', 'openai_base_url = "https://user-route.invalid/v1"');
  writeFileSync(base.configPath, before);
  const plan = prepareCodexIntegration(config, { migrateBase: true });
  expect(plan.migration!.restored).toContain("https://user-route.invalid/v1");
  const options = { target: profile, migrateBase: true, mode: "browser-only" as const, browserHostDescriptorPath: join(root, "descriptor.json"), acknowledgedUnofficial: true, subagentProtocol: "native" as const, port: 18272 };
  const preview = previewSetupConfiguration(options);
  expect(preview.status).toBe("ready");
  expect(preview.additionalTargets?.[0]?.target.id).toBe(base.id);
  expect(preview.textChanges?.map(change => change.path)).toEqual([profile.configPath, base.configPath]);
  expect(preview.effects!.some(effect => effect.includes("Quit the base launcher"))).toBe(true);
  expect(readFileSync(base.configPath, "utf8")).toBe(before);
}));
