import { readFileSync } from "node:fs";
import { getConfigPath, loadConfig, preserveUtf8Bom, stripUtf8Bom, type SubagentProtocol } from "./config";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import { inspectInstalledCodexConfig, type CodexIntegrationConflict } from "./codex-integration-inspection";
import { installCompatibilityV1Features } from "./codex-integration-document";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL, getCodexConfigPath, getCodexJournalPath,
  getCodexJournalRecoveryPath, getCodexModelsCachePath, routeUrl, serializeJournal,
  sha256, snapshotFile, writeFilesWithCompensation, type CodexIntegrationJournal,
  type FileSnapshot,
} from "./codex-integration-shared";
import { parseTomlValue, setTomlScalar } from "./toml-edit";
import type { CodexRepairPreview } from "./contracts/codex-integration";
export type { CodexRepairPreview, CodexRepairChange } from "./contracts/codex-integration";

type Scalar = string | number | boolean;
interface MaterializedRepair {
  preview: CodexRepairPreview;
  snapshots: FileSnapshot[];
  writes: Array<{ path: string; data: string }>;
  journal?: CodexIntegrationJournal;
}
function table(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function at(value: unknown, path: string[]): unknown {
  for (const key of path) value = table(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}
function scalar(value: unknown): Scalar | null {
  return typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : null;
}

function materialize(protocol: SubagentProtocol): MaterializedRepair {
  if (protocol !== "native" && protocol !== "compatibility-v1") throw new Error("Repair requires an explicit valid protocol choice");
  const preview: CodexRepairPreview = {
    version: 1, status: "blocked", approvalId: "", protocol, changes: [], conflicts: [],
    codexRestartRequired: true, launcherRestartRequired: true,
  };
  const snapshots = [getCodexConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath(), getConfigPath(), getCodexModelsCachePath()].map(snapshotFile);
  const blocked = (message: string): MaterializedRepair => {
    preview.conflicts.push({ path: "repair", category: "ownership_conflict", message });
    return { preview, snapshots, writes: [] };
  };
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(); }
  catch { return blocked("Runtime configuration must be readable before integration repair"); }
  if (config.purpose === "dev-harness") return blocked("The isolated DEV harness does not own Codex integration");
  let journal;
  try {
    journal = readJournal({ repair: false });
    if (journal) assertJournalTargetsConfig(journal, getCodexConfigPath());
  } catch (error) { return blocked(error instanceof Error ? error.message : "Installation journal needs attention"); }
  if (!journal || journal.version !== 10 || !journal.active) return blocked("Repair requires an active version 10 installation journal; missing or older ownership must be reviewed before migration");
  const original = snapshots[0]!.data?.toString("utf8");
  if (original === undefined) return blocked("Codex configuration is missing; restore or review it before repair");
  preview.conflicts = inspectInstalledCodexConfig(original, journal);
  if (preview.conflicts.some(conflict => !["missing", "value_changed"].includes(conflict.category))) return { preview, snapshots, writes: [] };
  let text = original;
  const next = structuredClone(journal);
  const edit = (path: string[], value: Scalar | undefined): void => {
    const current = at(parseTomlValue(text), path);
    if (current === value) return;
    text = setTomlScalar(text, path, value);
    preview.changes.push({ path: path.join("."), current: scalar(current), proposed: value ?? null });
  };
  try {
    edit(["openai_base_url"], routeUrl(config));
    edit(["experimental_realtime_webrtc_call_base_url"], CODEX_REALTIME_WEBRTC_CALL_BASE_URL);
    const v2Path = table(at(parseTomlValue(text), ["features", "multi_agent_v2"]))
      ? ["features", "multi_agent_v2", "enabled"] : ["features", "multi_agent_v2"];
    if (protocol === "compatibility-v1") {
      if (journal.installed.subagent_protocol === "native") {
        // Setup and repair capture the same semantic baseline. The preview's
        // scalar edits below retain the current document's source formatting.
        const captured = installCompatibilityV1Features(text);
        next.previousMultiAgent = captured.previousMultiAgent;
        next.previousMultiAgentV2 = captured.previousMultiAgentV2;
        next.previousAgentMaxDepth = captured.previousAgentMaxDepth;
        next.installed.agent_max_depth = captured.installedAgentMaxDepth;
      }
      edit(["features", "multi_agent"], true);
      edit(v2Path, false);
      edit(["agents", "max_depth"], next.installed.agent_max_depth!);
    } else if (journal.installed.subagent_protocol === "compatibility-v1") {
      for (const [path, installed, previous, numeric] of [
        [["features", "multi_agent"], true, journal.previousMultiAgent!, false],
        [v2Path, false, journal.previousMultiAgentV2!, false],
        [["agents", "max_depth"], journal.installed.agent_max_depth!, journal.previousAgentMaxDepth!, true],
      ] as const) {
        // Relinquish unchanged bridge-owned values; keep newer user choices.
        if (at(parseTomlValue(text), [...path]) === installed) {
          edit([...path], !previous.present || previous.value === "unset" ? undefined
            : numeric ? Number(previous.value) : previous.value === "true");
        }
      }
      delete next.previousMultiAgent;
      delete next.previousMultiAgentV2;
      delete next.previousAgentMaxDepth;
      delete next.installed.agent_max_depth;
    }
  } catch { return blocked("The proposed setting edit cannot preserve this document safely; review its structure before repair"); }
  next.installed.openai_base_url = routeUrl(config);
  next.installed.experimental_realtime_webrtc_call_base_url = CODEX_REALTIME_WEBRTC_CALL_BASE_URL;
  next.installed.subagent_protocol = protocol;
  if (journal.installed.subagent_protocol !== protocol) preview.changes.push({ path: "integration.subagent_protocol", current: journal.installed.subagent_protocol, proposed: protocol });
  const remaining = inspectInstalledCodexConfig(text, next);
  if (remaining.length) { preview.conflicts.push(...remaining); return { preview, snapshots, writes: [] }; }
  const journalData = serializeJournal(next);
  const writes = [{ path: getCodexJournalRecoveryPath(), data: journalData }];
  if (text !== original) writes.push({ path: getCodexConfigPath(), data: text });
  const runtimeText = snapshots[3]!.data?.toString("utf8");
  if (!runtimeText) return blocked("The runtime configuration disappeared before preview");
  const runtime = JSON.parse(stripUtf8Bom(runtimeText)) as Record<string, unknown>;
  if (runtime.subagentProtocol !== protocol) {
    preview.changes.push({ path: "runtime.subagentProtocol", current: scalar(runtime.subagentProtocol), proposed: protocol });
    runtime.subagentProtocol = protocol;
    writes.push({ path: getConfigPath(), data: preserveUtf8Bom(`${JSON.stringify(runtime, null, 2)}\n`, runtimeText) });
  }
  writes.push({ path: getCodexJournalPath(), data: journalData });
  preview.status = "ready";
  preview.approvalId = sha256(JSON.stringify({ version: 1, protocol,
    inputs: snapshots.map(file => [file.path, file.exists, file.data ? sha256(file.data) : null]),
    outputs: writes.map(file => [file.path, sha256(file.data)]),
  }));
  return { preview, snapshots, writes, journal: next };
}

export function previewCodexIntegrationRepair(protocol: SubagentProtocol): CodexRepairPreview {
  return materialize(protocol).preview;
}

/** Callers settle runtime ownership before applying; no runtime is started or stopped here. */
export function applyCodexIntegrationRepair(protocol: SubagentProtocol, approvalId: string): { changed: boolean; codexRestartRequired: true; launcherRestartRequired: true } {
  if (!/^[a-f0-9]{64}$/.test(approvalId)) throw new Error("Exact repair preview approval is required");
  const plan = materialize(protocol);
  if (plan.preview.status !== "ready" || plan.preview.approvalId !== approvalId || !plan.journal) {
    throw new Error("Repair inputs changed or need attention; review a fresh preview before approval");
  }
  const journal = plan.journal;
  writeFilesWithCompensation(plan.writes, [getCodexModelsCachePath()], {
    expected: plan.snapshots,
    verify: () => {
      if (inspectInstalledCodexConfig(readFileSync(getCodexConfigPath(), "utf8"), journal).length
        || loadConfig().subagentProtocol !== protocol) throw new Error("Codex integration repair verification failed");
    },
  });
  return { changed: true, codexRestartRequired: true, launcherRestartRequired: true };
}
