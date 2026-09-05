import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IntegrationTarget } from "./contracts/codex-integration";
import { resolveConfigurationSource } from "./codex-config-occurrences";
import { inspectCodexConfigSource } from "./codex-config-source";
import { CodexConfigurationError } from "./codex-configuration-error";
import { prepareProfileModelCatalog, profileModelCatalogPath } from "./profile-model-catalog";
import { assertProfileBaseLayer } from "./codex-profile-layers";
import { prepareBaseToProfileMigration } from "./codex-profile-migration";
import { prepareOwnedCodexConfiguration } from "./codex-owned-configuration";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig, preserveUtf8Bom, stripUtf8Bom } from "./config";
import { installCodexInterruptHook, installCodexInterruptHookCommand } from "./codex-interrupt-hook";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  codexModelCacheInvalidations,
  routeUrl,
  sha256,
  snapshotFile,
  writeIntegrationState,
  writeFilesWithCompensation,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  FileSnapshot,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import { inspectInstalledCodexConfig, type CodexIntegrationConflict } from "./codex-integration-inspection";
import {
  findTopLevelAssignment,
  installCompatibilityV1Features,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  assertPreservedPreviousRealtimeAssignment,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
  target?: IntegrationTarget,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
    target?.kind === "profile" ? profileModelCatalogPath(target) : undefined,
  );
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(route.text);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : route;
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(target), config.interruptHookCommand)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(target), config, target?.runtimeHome);
  return { ...configured, text: hook.text, interruptHook: hook.installed };
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 || journal.version === 10
    ? journal.installed.subagent_protocol
    : "native";
}

export {
  getCodexConfigPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
  target?: IntegrationTarget,
): AppConfig["subagentProtocol"] {
  const journal = readJournal({ repair: false, target });
  return journal?.version === 8 || journal?.version === 9 || journal?.version === 10
    ? journal.installed.subagent_protocol
    : fallback;
}

export function setCodexSubagentProtocol(
  _config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  const target = _config.integrationTarget;
  const status = inspectCodexIntegration({ target });
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const runtime = snapshotFile(getConfigPath(target?.runtimeHome));
  if (!runtime.data) throw new Error("Runtime configuration must exist before protocol selection");
  // A caller's cached config is not authority to overwrite unrelated newer settings.
  const nextConfig = { ...loadConfig(target?.runtimeHome), ...(target ? { integrationTarget: target } : {}), subagentProtocol: protocol };
  const plan = prepareCodexIntegration(nextConfig);
  const original = runtime.data.toString("utf8");
  const nextRuntime = { ...JSON.parse(stripUtf8Bom(original)), subagentProtocol: protocol };
  writeIntegrationState(plan.journal, plan.configWrite, plan.removals, {
    target,
    expected: [...plan.expected, runtime],
    additionalWrites: [...(plan.additionalWrites ?? []), { path: runtime.path, data: preserveUtf8Bom(`${JSON.stringify(nextRuntime, null, 2)}\n`, original) }],
    verify: () => { if (loadConfig(target?.runtimeHome).subagentProtocol !== protocol) throw new Error("Protocol selection did not persist"); },
  });
  return plan.journal;
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  prepareCodexIntegration(config, options);
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const target = options.target ?? config.integrationTarget;
  mkdirSync(dirname(getCodexConfigPath(target)), { recursive: true, mode: 0o700 });
  const plan = prepareCodexIntegration(config, options);
  return applyPreparedCodexIntegration(plan);
}

export function applyPreparedCodexIntegration(plan: IntegrationInstallPlan): CodexIntegrationJournal {
  mkdirSync(dirname(plan.configWrite.path), { recursive: true, mode: 0o700 });
  writeIntegrationState(plan.journal, plan.configWrite, plan.removals, { target: plan.target, expected: plan.expected, additionalWrites: plan.additionalWrites });
  return plan.journal;
}

export interface IntegrationInstallPlan {
  target?: IntegrationTarget;
  journal: CodexIntegrationJournal;
  configWrite: { path: string; data: string };
  removals: string[];
  expected: FileSnapshot[];
  additionalWrites?: Array<{ path: string; data: string }>;
  conflicts?: CodexIntegrationConflict[];
  migration?: ReturnType<typeof prepareBaseToProfileMigration>;
}

export function prepareCodexIntegration(config: AppConfig, options: InstallCodexIntegrationOptions & { reviewOwnedChanges?: boolean; migrateBase?: boolean } = {}): IntegrationInstallPlan {
  const target = options.target ?? config.integrationTarget;
  if (options.migrateBase && target?.kind !== "profile") throw new Error("Base migration requires a named profile target");
  const migration = options.migrateBase ? prepareBaseToProfileMigration(target!) : undefined;
  const configPath = getCodexConfigPath(target);
  const expected = [configPath, getCodexJournalPath(target), getCodexJournalRecoveryPath(target), ...codexModelCacheInvalidations(target)].map(snapshotFile);
  if (target?.kind === "profile") {
    const base = snapshotFile(join(target.codexHome, "config.toml"));
    expected.push(base);
    assertProfileBaseLayer(migration?.restored ?? base.data?.toString("utf8") ?? "", base.path);
  }
  if (migration) expected.push(...migration.expected);
  const configExists = expected[0]!.exists;
  const original = expected[0]!.data?.toString("utf8") ?? "";
  const currentText = resolveConfigurationSource(original, options.resolutions ?? []);
  const sourceConflicts = inspectCodexConfigSource(currentText).conflicts;
  if (sourceConflicts.length) throw new CodexConfigurationError(sourceConflicts);
  const catalog = target?.kind === "profile" ? prepareProfileModelCatalog(config, target, currentText) : undefined;
  if (catalog) expected.push(...catalog.expected);
  const additionalWrites = [...(catalog ? [catalog.write] : []), ...(migration?.writes ?? [])];
  const existing = readJournal({ repair: false, target });
  const installedUrl = routeUrl(config);
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    const reviewed = options.reviewOwnedChanges && existing.version === 10 && existing.active
      ? prepareOwnedCodexConfiguration(currentText, existing, config) : undefined;
    const installed = reviewed?.journal ?? existing;
    const workingText = reviewed?.text ?? currentText;
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedJournalState(workingText, installed);
      baseline = managedJournalIsActive(installed)
        ? restoreManagedRoute(workingText, installed)
        : workingText;
    } catch (error) {
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || existing.version === 10 || options.replaceExistingRoute === true,
      target,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      if (existing.version === 9 || existing.version === 10) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 10,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        subagent_protocol: config.subagentProtocol,
        ...(catalog ? { model_catalog_json: catalog.write.path, model_provider: "openai" } : {}),
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      previousRealtimeWebrtcCallBaseUrl: preservePrevious && (existing.version === 9 || existing.version === 10)
        ? existing.previousRealtimeWebrtcCallBaseUrl
        : patched.previousRealtimeWebrtcCallBaseUrl,
      interruptHook: patched.interruptHook,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    return { target, journal: updated, configWrite: { path: configPath, data: patched.text }, removals: [...codexModelCacheInvalidations(target), ...(migration?.removals ?? [])], expected, additionalWrites, conflicts: reviewed?.conflicts, migration };
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    expected.push(snapshotFile(existing.catalogPath));
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
    target,
  );
  const journal: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: config.subagentProtocol,
      ...(catalog ? { model_catalog_json: catalog.write.path, model_provider: "openai" } : {}),
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
    },
    previous: patched.previous,
    previousRealtimeWebrtcCallBaseUrl: patched.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: patched.interruptHook,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  return { target, journal, configWrite: { path: configPath, data: patched.text },
    removals: [...codexModelCacheInvalidations(target), ...(existing?.version === 2 ? [existing.catalogPath] : []), ...(migration?.removals ?? [])], expected, additionalWrites, migration };
}

export function deactivateCodexIntegration(target?: IntegrationTarget): SetCodexIntegrationActiveResult {
  const journalInputs = [getCodexJournalPath(target), getCodexJournalRecoveryPath(target)].map(snapshotFile);
  const existing = readJournal({ repair: false, target });
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath(target));
  const expected = [snapshotFile(existing.configPath), ...journalInputs, ...codexModelCacheInvalidations(target).map(snapshotFile)];
  if (!expected[0]!.exists) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = expected[0]!.data!.toString("utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV9
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  writeIntegrationState(disconnected, { path: existing.configPath, data: restored }, codexModelCacheInvalidations(target), { expected, target });
  return { changed: true, active: false };
}

export function activateCodexIntegration(target?: IntegrationTarget): SetCodexIntegrationActiveResult {
  const catalog = target?.kind === "profile" ? prepareProfileModelCatalog(loadConfig(target.runtimeHome), target) : undefined;
  const journalInputs = [getCodexJournalPath(target), getCodexJournalRecoveryPath(target)].map(snapshotFile);
  const existing = readJournal({ repair: false, target });
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath(target));
  const expected = [snapshotFile(existing.configPath), ...journalInputs, ...codexModelCacheInvalidations(target).map(snapshotFile)];
  if (catalog) {
    const base = snapshotFile(join(target!.codexHome, "config.toml"));
    expected.push(...catalog.expected, base);
    assertProfileBaseLayer(base.data?.toString("utf8") ?? "", base.path);
  }
  if (!expected[0]!.exists) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = expected[0]!.data!.toString("utf8");
  if (existing.version === 10 && existing.active) {
    verifyInstalledRoute(current, existing);
    return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10) && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const hookConfig = existing.version === 10
    ? { interruptHookCommand: existing.interruptHook.command }
    : { runtimeCommand: loadConfig(target?.runtimeHome).runtimeCommand };
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { subagentProtocol: protocol, ...hookConfig },
    true,
    existing.version === 9 || existing.version === 10,
    target,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  if (existing.version === 9 || existing.version === 10) {
    assertPreservedPreviousRealtimeAssignment(
      route.previousRealtimeWebrtcCallBaseUrl,
      existing.previousRealtimeWebrtcCallBaseUrl,
    );
  }
  const connected: CodexIntegrationJournal = {
    version: 10,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: protocol,
      ...(catalog ? { model_catalog_json: catalog.write.path, model_provider: "openai" } : {}),
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
    },
    previous: existing.previous,
    previousRealtimeWebrtcCallBaseUrl: existing.version === 9 || existing.version === 10
      ? existing.previousRealtimeWebrtcCallBaseUrl
      : route.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: route.interruptHook,
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(connected, { path: existing.configPath, data: route.text }, codexModelCacheInvalidations(target), { expected, target, additionalWrites: catalog ? [catalog.write] : [] });
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(target?: IntegrationTarget): UninstallCodexIntegrationResult {
  const journalInputs = [getCodexJournalPath(target), getCodexJournalRecoveryPath(target)].map(snapshotFile);
  const journal = readJournal({ repair: false, target });
  if (!journal) return { changed: false };
  assertJournalTargetsConfig(journal, getCodexConfigPath(target));
  const expected = [snapshotFile(getCodexConfigPath(target)), ...journalInputs, ...codexModelCacheInvalidations(target).map(snapshotFile)];
  if (!expected[0]!.exists) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = expected[0]!.data!.toString("utf8");
  let restored: string;
  if (journal.version === 2) {
    expected.push(snapshotFile(journal.catalogPath));
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    restored = restoreManagedRoute(current, journal);
  }
  writeFilesWithCompensation([{ path: journal.configPath, data: restored }], [
    ...(journal.version === 2 ? [journal.catalogPath] : []),
    ...codexModelCacheInvalidations(target), getCodexJournalPath(target), getCodexJournalRecoveryPath(target),
  ], { expected });
  return { changed: true };
}

export function inspectCodexIntegration({ readOnly = false, target }: { readOnly?: boolean; target?: IntegrationTarget } = {}): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
  conflicts: CodexIntegrationConflict[];
} {
  const journal = readJournal({ repair: !readOnly, target });
  const errors: string[] = [];
  const conflicts: CodexIntegrationConflict[] = [];
  if (target?.kind === "profile") {
    try { assertProfileBaseLayer(snapshotFile(join(target.codexHome, "config.toml")).data?.toString("utf8") ?? "", join(target.codexHome, "config.toml")); }
    catch (error) {
      if (error instanceof CodexConfigurationError) conflicts.push(...error.conflicts);
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath(target));
      const text = readFileSync(journal.configPath, "utf8");
      if (readOnly && (journal.version === 8 || journal.version === 9 || journal.version === 10) && journal.active) {
        conflicts.push(...inspectInstalledCodexConfig(text, journal));
        errors.push(...conflicts.map(conflict => conflict.message));
      }
      else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) && !journal.active) {
        verifyRestoredRoute(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10) {
        verifyInstalledRoute(text, journal);
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(target),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
    conflicts,
  };
}
