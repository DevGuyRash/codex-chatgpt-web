import type { AppConfig } from "./config";
import { inspectInstalledCodexConfig } from "./codex-integration-inspection";
import { installCompatibilityV1Features } from "./codex-integration-document";
import { CODEX_REALTIME_WEBRTC_CALL_BASE_URL, routeUrl, type CodexIntegrationJournal } from "./codex-integration-shared";
import { parseTomlValue } from "./toml-edit";
import { boundCodexRouteSection, setTrackedCodexScalar } from "./codex-config-source";
import { CodexConfigurationError } from "./codex-configuration-error";
import { ownedCodexScalarSettings } from "./codex-owned-settings";

type Scalar = string | number | boolean;
const table = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function at(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = table(value) && Object.hasOwn(value, key) ? value[key] : undefined;
  return value;
}

/** Pure preparation, not authority to write. Setup and repair approve the resulting exact file plan. */
export function prepareOwnedCodexConfiguration(original: string, journal: CodexIntegrationJournal, config: AppConfig) {
  if (!journal.active) throw new CodexConfigurationError([{ path: "integration", category: "ownership_conflict", message: "Repair requires an active installation" }]);
  const conflicts = inspectInstalledCodexConfig(original, journal);
  if (conflicts.some(conflict => !["missing", "commented_out", "value_changed"].includes(conflict.category))) throw new CodexConfigurationError(conflicts);
  let text = original;
  const next = structuredClone(journal);
  next.installed.openai_base_url = routeUrl(config);
  next.installed.experimental_realtime_webrtc_call_base_url = CODEX_REALTIME_WEBRTC_CALL_BASE_URL;
  next.installed.subagent_protocol = config.subagentProtocol;
  const edit = (path: string[], value: Scalar | undefined): void => {
    if (at(parseTomlValue(text), path) !== value) text = setTrackedCodexScalar(text, path, value);
  };
  try {
    const v2Path = table(at(parseTomlValue(text), ["features", "multi_agent_v2"]))
      ? ["features", "multi_agent_v2", "enabled"] : ["features", "multi_agent_v2"];
    if (config.subagentProtocol === "compatibility-v1") {
      if (journal.installed.subagent_protocol === "native") {
        const captured = installCompatibilityV1Features(text);
        next.previousMultiAgent = captured.previousMultiAgent;
        next.previousMultiAgentV2 = captured.previousMultiAgentV2;
        next.previousAgentMaxDepth = captured.previousAgentMaxDepth;
        next.installed.agent_max_depth = captured.installedAgentMaxDepth;
      }
    } else if (journal.installed.subagent_protocol === "compatibility-v1") {
      for (const [path, installed, previous, numeric] of [
        [["features", "multi_agent"], true, journal.previousMultiAgent!, false],
        [v2Path, false, journal.previousMultiAgentV2!, false],
        [["agents", "max_depth"], journal.installed.agent_max_depth!, journal.previousAgentMaxDepth!, true],
      ] as const) {
        // Relinquish unchanged bridge-owned values, retaining newer user choices.
        if (at(parseTomlValue(text), path) === installed) edit([...path], !previous.present || previous.value === "unset" ? undefined
          : numeric ? Number(previous.value) : previous.value === "true");
      }
      delete next.previousMultiAgent;
      delete next.previousMultiAgentV2;
      delete next.previousAgentMaxDepth;
      delete next.installed.agent_max_depth;
    }
    for (const setting of ownedCodexScalarSettings(next, parseTomlValue(text))) edit(setting.path, setting.expected);
    text = boundCodexRouteSection(text);
  } catch {
    throw new CodexConfigurationError([...conflicts, { path: "config", category: "ownership_conflict", message: "The proposed setting edit cannot preserve this document safely; review its structure before repair" }]);
  }
  const remaining = inspectInstalledCodexConfig(text, next);
  if (remaining.length) throw new CodexConfigurationError([...conflicts, ...remaining]);
  return { text, journal: next, conflicts };
}
