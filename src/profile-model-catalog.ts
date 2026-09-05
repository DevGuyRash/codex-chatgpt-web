import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { IntegrationTarget } from "./contracts/codex-integration";
import { assertProfileCapabilities, profileCapabilityPath } from "./codex-profile-capabilities";
import { snapshotFile, writeFilesWithCompensation } from "./codex-integration-shared";
import { augmentNativeModelCatalog } from "./model-catalog";
import { readCodexModelContextOverride } from "./codex-integration-document";
import { assertProfileBaseLayer } from "./codex-profile-layers";
import { CHATGPT_WEB_MODEL_PREFIX } from "./chatgpt-web-models";

export function profileModelCatalogPath(target: IntegrationTarget): string { return join(target.runtimeHome, "codex", "model-catalog.json"); }

/** Native cache is read-only input; a missing cache falls back to the currently verified binary's metadata. */
export function prepareProfileModelCatalog(config: AppConfig, target: IntegrationTarget, proposedSource?: string) {
  const capability = assertProfileCapabilities(target);
  const source = snapshotFile(join(target.codexHome, "models_cache.json"));
  let native: unknown;
  try { native = source.data ? JSON.parse(source.data.toString("utf8")) : undefined; } catch { /* Use current bundled metadata. */ }
  const models = native && typeof native === "object" ? (native as { models?: unknown }).models : undefined;
  const augmented = Array.isArray(models) && models.some(model => model && typeof model.slug === "string" && model.slug.startsWith(CHATGPT_WEB_MODEL_PREFIX));
  if (!Array.isArray(models) || !models.length || augmented) {
    const root = mkdtempSync(join(tmpdir(), "cgw-native-metadata-"));
    try {
      const result = spawnSync(capability.executable, ["debug", "models", "--bundled"], {
        cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, CODEX_HOME: root },
        encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) throw new Error("Current native model metadata is unavailable; refresh Codex's native catalog or repeat the capability check before profile setup");
      native = JSON.parse(result.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const path = profileModelCatalogPath(target);
  return {
    write: { path, data: `${JSON.stringify(augmentNativeModelCatalog(native, config, readCodexModelContextOverride(target, proposedSource)))}\n` },
    expected: [source, snapshotFile(profileCapabilityPath(target)), snapshotFile(join(target.codexHome, "config.toml")), snapshotFile(target.configPath), snapshotFile(path)],
  };
}

export function refreshProfileModelCatalog(config: AppConfig): boolean {
  const target = config.integrationTarget;
  if (target?.kind !== "profile") return false;
  const base = snapshotFile(join(target.codexHome, "config.toml"));
  assertProfileBaseLayer(base.data?.toString("utf8") ?? "", base.path);
  const plan = prepareProfileModelCatalog(config, target);
  if (plan.expected.at(-1)?.data?.toString("utf8") === plan.write.data) return false;
  writeFilesWithCompensation([plan.write], [], { expected: plan.expected });
  return true;
}

/** Startup and health checks maintain this target's file; readiness is not proof Codex loaded it. */
export function profileCatalogRefreshCheck(config: AppConfig): () => { ready: boolean; error?: string } | undefined {
  const target = config.integrationTarget;
  if (target?.kind !== "profile") return () => undefined;
  let fingerprint = "";
  let status: { ready: boolean; error?: string } = { ready: false };
  let retryAfter = 0;
  const paths = [join(target.codexHome, "models_cache.json"), join(target.codexHome, "config.toml"), target.configPath, profileCapabilityPath(target), profileModelCatalogPath(target), assertProfileCapabilities(target).executable];
  const signature = () => paths.map(path => {
    try { const stat = statSync(path, { bigint: true }); return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
    catch { return "missing"; }
  }).join("|");
  const check = () => {
    const current = signature();
    if (current === fingerprint || Date.now() < retryAfter) return status;
    try {
      refreshProfileModelCatalog(config);
      paths[paths.length - 1] = assertProfileCapabilities(target).executable;
      fingerprint = signature();
      status = { ready: true };
      retryAfter = 0;
    } catch (error) {
      status = { ready: false, error: error instanceof Error ? error.message : String(error) };
      retryAfter = Date.now() + 30_000;
    }
    return status;
  };
  const initial = check();
  if (!initial.ready) throw new Error(initial.error ?? "Profile model catalog is unavailable");
  return check;
}
