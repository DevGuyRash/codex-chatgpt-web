import type { AnyCodexIntegrationJournal } from "./codex-integration-shared";
import type { CodexConfigScalar } from "./contracts/codex-integration";

export type InspectableCodexJournal = Extract<AnyCodexIntegrationJournal, { version: 8 | 9 | 10 }>;
export interface OwnedCodexScalar { path: string[]; expected: CodexConfigScalar }

export function codexSettingAt(document: unknown, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((value, key) => value && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string | number, unknown>)[key] : undefined, document);
}

/** One ownership projection used by inspection, repair and review. Native feature choices are not owned. */
export function ownedCodexScalarSettings(journal: InspectableCodexJournal, document: unknown): OwnedCodexScalar[] {
  const settings: OwnedCodexScalar[] = [{ path: ["openai_base_url"], expected: journal.installed.openai_base_url }];
  if (journal.version === 10) {
    for (const key of ["model_catalog_json", "model_provider"] as const) {
      const expected = journal.installed[key];
      if (expected !== undefined) settings.push({ path: [key], expected });
    }
  }
  if (journal.version !== 8) settings.push({ path: ["experimental_realtime_webrtc_call_base_url"], expected: journal.installed.experimental_realtime_webrtc_call_base_url });
  if (journal.installed.subagent_protocol === "compatibility-v1") {
    const v2 = codexSettingAt(document, ["features", "multi_agent_v2"]);
    settings.push({ path: ["features", "multi_agent"], expected: true },
      { path: v2 !== null && typeof v2 === "object" && !Array.isArray(v2) ? ["features", "multi_agent_v2", "enabled"] : ["features", "multi_agent_v2"], expected: false });
    if (journal.installed.agent_max_depth !== undefined) settings.push({ path: ["agents", "max_depth"], expected: journal.installed.agent_max_depth });
  }
  return settings;
}
