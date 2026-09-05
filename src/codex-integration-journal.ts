import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteFile, stripUtf8Bom } from "./config";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  serializeJournal,
  writeFilesWithCompensation,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  LegacyCodexIntegrationJournal,
  LegacyCodexIntegrationJournalV9,
  LegacyCodexIntegrationJournalV3,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
} from "./codex-integration-shared";
import { verifyManagedJournalState } from "./codex-integration-route";
import { inspectInstalledCodexConfig } from "./codex-integration-inspection";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPreviousAssignment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const assignment = value as Record<string, unknown>;
  if (typeof assignment.present !== "boolean") return false;
  if (assignment.index !== undefined && (!Number.isSafeInteger(assignment.index) || Number(assignment.index) < 0)) return false;
  return !assignment.present
    || (typeof assignment.rawLine === "string" && typeof assignment.value === "string");
}

function isPreviousFeature(value: unknown, key: "multi_agent" | "multi_agent_v2"): boolean {
  if (!isRecord(value) || !isPreviousAssignment(value) || typeof value.tablePresent !== "boolean") return false;
  if (value.tableName !== undefined && value.tableName !== "features" && value.tableName !== "features.multi_agent_v2") return false;
  if (key === "multi_agent" && (value.tableName === "features.multi_agent_v2" || value.inlineTable === true)) return false;
  if (value.inlineTable !== undefined && typeof value.inlineTable !== "boolean") return false;
  if (value.separatorInserted !== undefined && typeof value.separatorInserted !== "boolean") return false;
  if (!value.present) return true;
  if (!value.tablePresent) return false;
  try {
    const parsed = Bun.TOML.parse(value.rawLine as string) as Record<string, unknown>;
    const assignmentKey = value.tableName === "features.multi_agent_v2" ? "enabled" : key;
    if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, assignmentKey)) return false;
    const actual = parsed[assignmentKey];
    if (value.inlineTable) {
      if (!isRecord(actual)) return false;
      return actual.enabled === undefined ? value.value === "unset"
        : typeof actual.enabled === "boolean" && String(actual.enabled) === value.value;
    }
    return typeof actual === "boolean" && String(actual) === value.value;
  } catch { return false; }
}

function isPreviousDepth(value: unknown): boolean {
  if (!isRecord(value) || !isPreviousAssignment(value) || typeof value.tablePresent !== "boolean") return false;
  if (value.separatorInserted !== undefined && typeof value.separatorInserted !== "boolean") return false;
  if (!value.present) return true;
  if (!value.tablePresent) return false;
  try {
    const parsed = Bun.TOML.parse(value.rawLine as string) as Record<string, unknown>;
    return Object.keys(parsed).length === 1 && Object.hasOwn(parsed, "max_depth")
      && Number.isSafeInteger(parsed.max_depth) && Number(parsed.max_depth) > 0
      && String(parsed.max_depth) === value.value;
  } catch { return false; }
}

function isPreviousString(value: unknown, key: string): boolean {
  if (!isRecord(value) || !isPreviousAssignment(value)) return false;
  if (!value.present) return true;
  try {
    const parsed = Bun.TOML.parse(value.rawLine as string) as Record<string, unknown>;
    return Object.keys(parsed).length === 1 && Object.hasOwn(parsed, key)
      && typeof parsed[key] === "string" && parsed[key] === value.value;
  } catch { return false; }
}

function hasModernOwnership(value: Record<string, unknown>): boolean {
  if (!isRecord(value.previous) || !isRecord(value.installed)) return false;
  const previous = value.previous;
  if (!["openai_base_url", "model_provider", "model_catalog_json"].every(key => isPreviousString(previous[key], key))) return false;
  if ((value.version === 9 || value.version === 10)
    && !isPreviousString(value.previousRealtimeWebrtcCallBaseUrl, "experimental_realtime_webrtc_call_base_url")) return false;
  if (typeof value.installed.openai_base_url !== "string" || !value.installed.openai_base_url) return false;
  return value.installed.subagent_protocol !== "compatibility-v1"
    || (isPreviousFeature(value.previousMultiAgent, "multi_agent")
      && isPreviousFeature(value.previousMultiAgentV2, "multi_agent_v2")
      && isPreviousDepth(value.previousAgentMaxDepth));
}

function isInstalledInterruptHook(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hook = value as Record<string, unknown>;
  return typeof hook.command === "string" && hook.command.length > 0
    && Number.isSafeInteger(hook.groupIndex) && (hook.groupIndex as number) >= 0
    && typeof hook.stateKey === "string" && hook.stateKey.length > 0
    && typeof hook.trustedHash === "string" && /^sha256:[a-f0-9]{64}$/.test(hook.trustedHash)
    && typeof hook.fragment === "string" && hook.fragment.length > 0;
}

function parseJournal(path: string): AnyCodexIntegrationJournal {
  let input: unknown;
  try { input = JSON.parse(stripUtf8Bom(readFileSync(path, "utf8"))); }
  catch { throw new Error(`Invalid Codex integration journal: ${path}`); }
  if (!isRecord(input)) throw new Error(`Invalid Codex integration journal: ${path}`);
  const value = input;
  if ((value.version === 8 || value.version === 9 || value.version === 10) && !hasModernOwnership(value)) {
    throw new Error(`Invalid Codex integration journal: ${path}`);
  }
  const installed = value.installed as Record<string, unknown> | undefined;
  if (value.version === 10
    && typeof value.active === "boolean"
    && installed
    && typeof installed.openai_base_url === "string"
    && installed.experimental_realtime_webrtc_call_base_url === CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && isPreviousAssignment(value.previousRealtimeWebrtcCallBaseUrl)
    && isInstalledInterruptHook(value.interruptHook)
    && typeof value.configPath === "string") {
    return value as unknown as CodexIntegrationJournal;
  }
  if (value.version === 9
    && typeof value.active === "boolean"
    && installed
    && typeof installed.openai_base_url === "string"
    && installed.experimental_realtime_webrtc_call_base_url === CODEX_REALTIME_WEBRTC_CALL_BASE_URL
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && isPreviousAssignment(value.previousRealtimeWebrtcCallBaseUrl)
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV9;
  }
  if (value.version === 8
    && typeof value.active === "boolean"
    && installed
    && (installed.subagent_protocol === "compatibility-v1" || installed.subagent_protocol === "native")
    && (installed.subagent_protocol !== "compatibility-v1"
      || (value.previousMultiAgent && value.previousMultiAgentV2
        && value.previousAgentMaxDepth
        && typeof installed.agent_max_depth === "number"
        && Number.isSafeInteger(installed.agent_max_depth)
        && installed.agent_max_depth >= 2))
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV8;
  }
  if (value.version === 7
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV7;
  }
  if (value.version === 6
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && value.previousMultiAgentV2
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV6;
  }
  if (value.version === 5
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && value.previousRemoteCompactionV2
    && value.previousMultiAgent
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV5;
  }
  if (value.version === 4
    && typeof value.active === "boolean"
    && value.installed
    && value.previous
    && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV4;
  }
  if (value.version === 3 && value.installed && value.previous && typeof value.configPath === "string") {
    return value as unknown as LegacyCodexIntegrationJournalV3;
  }
  if (value.version === 2 && value.installed && value.previous && typeof value.providerBlock === "string") {
    return value as unknown as LegacyCodexIntegrationJournal;
  }
  throw new Error(`Invalid Codex integration journal: ${path}`);
}
function journalMatchesConfig(journal: AnyCodexIntegrationJournal, semantic = false): boolean {
  try {
    assertJournalTargetsConfig(journal, getCodexConfigPath());
    if (!existsSync(journal.configPath)) return false;
    const text = readFileSync(journal.configPath, "utf8");
    if (semantic && (journal.version === 8 || journal.version === 9 || journal.version === 10) && journal.active) {
      return inspectInstalledCodexConfig(text, journal).length === 0;
    }
    if (journal.version === 2) return text.includes(journal.providerBlock);
    verifyManagedJournalState(text, journal);
    return true;
  } catch {
    return false;
  }
}

/** A newer recovery intent may add ownership while preserving every older baseline.
 * Both records must independently match the configuration before using this proof.
 */
function additiveRecoveryUpgrade(primary: AnyCodexIntegrationJournal, recovery: AnyCodexIntegrationJournal): boolean {
  if ((primary.version !== 8 && primary.version !== 9)
    || (recovery.version !== 9 && recovery.version !== 10)
    || recovery.version <= primary.version) return false;
  const projected = structuredClone(recovery) as unknown as Record<string, unknown>;
  projected.version = primary.version;
  if (primary.version < 10) delete projected.interruptHook;
  if (primary.version === 8) {
    delete projected.previousRealtimeWebrtcCallBaseUrl;
    delete (projected.installed as Record<string, unknown>).experimental_realtime_webrtc_call_base_url;
  }
  return isDeepStrictEqual(projected, primary);
}

export function readJournal({ repair = true }: { repair?: boolean } = {}): AnyCodexIntegrationJournal | undefined {
  const primaryPath = getCodexJournalPath();
  const recoveryPath = getCodexJournalRecoveryPath();
  let primary: AnyCodexIntegrationJournal | undefined;
  let recovery: AnyCodexIntegrationJournal | undefined;
  let primaryError: unknown;
  let recoveryError: unknown;
  if (existsSync(primaryPath)) {
    try { primary = parseJournal(primaryPath); } catch (error) { primaryError = error; }
  }
  if (existsSync(recoveryPath)) {
    try { recovery = parseJournal(recoveryPath); } catch (error) { recoveryError = error; }
  }
  if (!primary && !recovery) {
    if (primaryError) throw primaryError;
    if (recoveryError) throw recoveryError;
    return undefined;
  }
  if (primary && recovery && serializeJournal(primary) === serializeJournal(recovery)) return primary;
  if (primary && !recovery && !recoveryError) {
    if (repair) atomicWriteFile(recoveryPath, serializeJournal(primary));
    return primary;
  }
  if (recovery && !primary && !primaryError) {
    if (!journalMatchesConfig(recovery, !repair)) {
      throw new Error("Codex integration recovery journal does not match the active config");
    }
    if (repair) atomicWriteFile(primaryPath, serializeJournal(recovery));
    return recovery;
  }

  const primaryMatches = primary ? journalMatchesConfig(primary, !repair) : false;
  const recoveryMatches = recovery ? journalMatchesConfig(recovery, !repair) : false;
  const upgrade = primaryMatches && recoveryMatches && primary && recovery && additiveRecoveryUpgrade(primary, recovery);
  if (primaryMatches === recoveryMatches && !upgrade) {
    throw new Error(
      primaryMatches
        ? "Codex integration journal copies contain different baselines for the same config"
        : "Codex integration journal copies do not match the active config",
    );
  }
  const selected = upgrade || !primaryMatches ? recovery! : primary!;
  const data = serializeJournal(selected);
  if (repair) writeFilesWithCompensation([
    { path: recoveryPath, data },
    { path: primaryPath, data },
  ]);
  return selected;
}

export function assertJournalTargetsConfig(
  journal: AnyCodexIntegrationJournal,
  configPath: string,
): void {
  const pathIdentity = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  if (pathIdentity(journal.configPath) !== pathIdentity(configPath)) {
    throw new Error(
      `Codex integration journal belongs to ${journal.configPath}, not the active config ${configPath}`,
    );
  }
}
