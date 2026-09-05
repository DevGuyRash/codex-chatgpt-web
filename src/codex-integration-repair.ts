import { readFileSync } from "node:fs";
import { getConfigPath, loadConfig, preserveUtf8Bom, stripUtf8Bom, type SubagentProtocol } from "./config";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import { inspectInstalledCodexConfig } from "./codex-integration-inspection";
import {
  getCodexConfigPath, getCodexJournalPath,
  getCodexJournalRecoveryPath, getCodexModelsCachePath, serializeJournal,
  codexModelCacheInvalidations,
  snapshotFile, writeFilesWithCompensation, type CodexIntegrationJournal,
  type FileSnapshot,
} from "./codex-integration-shared";
import { prepareOwnedCodexConfiguration } from "./codex-owned-configuration";
import { CodexConfigurationError } from "./codex-configuration-error";
import { configurationApprovalId, describeCodexConfigurationChanges, describeCodexSourceChange } from "./codex-configuration-plan";
import type { CodexRepairPreview } from "./contracts/codex-integration";
import { configurationReviewContext, withConfigurationReview } from "./codex-configuration-review";
import { join } from "node:path";
import { prepareProfileModelCatalog } from "./profile-model-catalog";
import { assertProfileBaseLayer } from "./codex-profile-layers";
import { resolveIntegrationTarget } from "./codex-integration-target";
import { resolveConfigurationSource } from "./codex-config-occurrences";
import type { IntegrationTarget, ConfigurationResolutionSelection } from "./contracts/codex-integration";
export type { CodexRepairPreview, CodexRepairChange } from "./contracts/codex-integration";

type Scalar = string | number | boolean;
interface MaterializedRepair {
  preview: CodexRepairPreview;
  snapshots: FileSnapshot[];
  writes: Array<{ path: string; data: string }>;
  journal?: CodexIntegrationJournal;
}
function scalar(value: unknown): Scalar | null {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : null;
}

export interface RepairOptions { target?: IntegrationTarget; resolutions?: ConfigurationResolutionSelection[] }
function materialize(protocol: SubagentProtocol, options: RepairOptions = {}): MaterializedRepair {
  const target = options.target;
  if (protocol !== "native" && protocol !== "compatibility-v1") throw new Error("Repair requires an explicit valid protocol choice");
  const preview: CodexRepairPreview = {
    version: 1, status: "blocked", approvalId: "", protocol, changes: [], conflicts: [],
    codexRestartRequired: true, launcherRestartRequired: true,
  };
  const snapshots = [getCodexConfigPath(target), getCodexJournalPath(target), getCodexJournalRecoveryPath(target), getConfigPath(target?.runtimeHome), ...codexModelCacheInvalidations(target)].map(snapshotFile);
  if (target?.kind === "profile") snapshots.push(snapshotFile(join(target.codexHome, "config.toml")));
  const blocked = (message: string): MaterializedRepair => {
    preview.conflicts.push({ path: "repair", category: "ownership_conflict", message });
    return { preview, snapshots, writes: [] };
  };
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(target?.runtimeHome); }
  catch { return blocked("Runtime configuration must be readable before integration repair"); }
  if (config.purpose === "dev-harness") return blocked("The isolated DEV harness does not own Codex integration");
  let journal;
  try {
    journal = readJournal({ repair: false, target });
    if (journal) assertJournalTargetsConfig(journal, getCodexConfigPath(target));
  } catch (error) { return blocked(error instanceof Error ? error.message : "Installation journal needs attention"); }
  if (!journal || journal.version !== 10 || !journal.active) return blocked("Repair requires an active version 10 installation journal; missing or older ownership must be reviewed before migration");
  const original = snapshots[0]!.data?.toString("utf8");
  if (original === undefined) return blocked("Codex configuration is missing; restore or review it before repair");
  let prepared: ReturnType<typeof prepareOwnedCodexConfiguration>;
  try {
    if (target?.kind === "profile") {
      const path = join(target.codexHome, "config.toml");
      assertProfileBaseLayer(snapshots.find(input => input.path === path)?.data?.toString("utf8") ?? "", path);
    }
    prepared = prepareOwnedCodexConfiguration(resolveConfigurationSource(original, options.resolutions ?? []), journal, { ...config, subagentProtocol: protocol });
  } catch (error) {
    if (!(error instanceof CodexConfigurationError)) throw error;
    preview.conflicts = error.conflicts;
    return { preview, snapshots, writes: [] };
  }
  const { text, journal: next } = prepared;
  const catalog = target?.kind === "profile" ? prepareProfileModelCatalog({ ...config, subagentProtocol: protocol }, target, text) : undefined;
  if (catalog) snapshots.push(...catalog.expected);
  preview.conflicts = prepared.conflicts;
  preview.textChanges = describeCodexSourceChange(getCodexConfigPath(target), original, text);
  preview.changes = describeCodexConfigurationChanges(original, text);
  if (journal.installed.subagent_protocol !== protocol) preview.changes.push({ path: "integration.subagent_protocol", current: journal.installed.subagent_protocol, proposed: protocol });
  const journalData = serializeJournal(next);
  const writes = [{ path: getCodexJournalRecoveryPath(target), data: journalData }];
  if (catalog) writes.push(catalog.write);
  if (text !== original) writes.push({ path: getCodexConfigPath(target), data: text });
  const runtimeText = snapshots[3]!.data?.toString("utf8");
  if (!runtimeText) return blocked("The runtime configuration disappeared before preview");
  const runtime = JSON.parse(stripUtf8Bom(runtimeText)) as Record<string, unknown>;
  if (runtime.subagentProtocol !== protocol) {
    preview.changes.push({ path: "runtime.subagentProtocol", current: scalar(runtime.subagentProtocol), proposed: protocol });
    runtime.subagentProtocol = protocol;
    writes.push({ path: getConfigPath(target?.runtimeHome), data: preserveUtf8Bom(`${JSON.stringify(runtime, null, 2)}\n`, runtimeText) });
  }
  writes.push({ path: getCodexJournalPath(target), data: journalData });
  preview.status = "ready";
  preview.resolutions = options.resolutions ?? [];
  preview.approvalId = configurationApprovalId({ operation: "repair", protocol, target, resolutions: preview.resolutions }, snapshots, writes, codexModelCacheInvalidations(target));
  return { preview, snapshots, writes, journal: next };
}

export function previewCodexIntegrationRepair(protocol: SubagentProtocol, options: RepairOptions = {}): CodexRepairPreview {
  const plan = materialize(protocol, options);
  const target = options.target ?? resolveIntegrationTarget();
  return withConfigurationReview({ ...plan.preview, resolutions: options.resolutions ?? [] }, target, plan.snapshots[0]?.data?.toString("utf8") ?? "", configurationReviewContext(target, plan.snapshots, plan.journal));
}

/** Callers settle runtime ownership before applying; no runtime is started or stopped here. */
export function applyCodexIntegrationRepair(protocol: SubagentProtocol, approvalId: string, options: RepairOptions = {}): { changed: boolean; codexRestartRequired: true; launcherRestartRequired: true } {
  if (!/^[a-f0-9]{64}$/.test(approvalId)) throw new Error("Exact repair preview approval is required");
  const plan = materialize(protocol, options);
  if (plan.preview.status !== "ready" || plan.preview.approvalId !== approvalId || !plan.journal) {
    throw new Error("Repair inputs changed or need attention; review a fresh preview before approval");
  }
  const journal = plan.journal;
  writeFilesWithCompensation(plan.writes, codexModelCacheInvalidations(options.target), {
    expected: plan.snapshots,
    verify: () => {
      if (inspectInstalledCodexConfig(readFileSync(getCodexConfigPath(options.target), "utf8"), journal).length
        || loadConfig(options.target?.runtimeHome).subagentProtocol !== protocol) throw new Error("Codex integration repair verification failed");
    },
  });
  return { changed: true, codexRestartRequired: true, launcherRestartRequired: true };
}
