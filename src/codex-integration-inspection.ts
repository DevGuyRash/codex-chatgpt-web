import { parseTomlValue } from "./toml-edit";
import { inspectCodexInterruptHook } from "./codex-interrupt-hook";
import { inspectCodexConfigSource, sourceAssignments } from "./codex-config-source";
import type { AnyCodexIntegrationJournal } from "./codex-integration-shared";
import { ownedCodexScalarSettings } from "./codex-owned-settings";

import type { CodexIntegrationConflict } from "./contracts/codex-integration";
export type { CodexIntegrationConflict } from "./contracts/codex-integration";

type InspectableJournal = Extract<AnyCodexIntegrationJournal, { version: 8 | 9 | 10 }>;
type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Table : undefined;
}

function at(document: Table, path: string[]): unknown {
  let value: unknown = document;
  for (const key of path) value = table(value)?.[key];
  return value;
}

/** Parse once and compare owned values, independent of comments and TOML layout. No writes. */
export function inspectInstalledCodexConfig(text: string, journal: InspectableJournal): CodexIntegrationConflict[] {
  const source = inspectCodexConfigSource(text);
  if (source.conflicts.some(conflict => conflict.category === "invalid_config")) return source.conflicts;
  let document: Table;
  try {
    const parsed = table(parseTomlValue(text));
    if (!parsed) throw new Error("Expected TOML document");
    document = parsed;
  } catch {
    // Parser exceptions can quote arbitrary private configuration text.
    return [{ path: "config", category: "invalid_config", message: "Codex configuration is not valid, unambiguous TOML; inspect it before attempting repair" }];
  }
  const conflicts: CodexIntegrationConflict[] = [...source.conflicts];
  const check = (path: string[], expected: string | boolean | number): void => {
    const current = at(document, path);
    if (current === expected) return;
    const key = path.join(".");
    const disabled = sourceAssignments(source, path).filter(item => item.state === "commented_out");
    conflicts.push({
      path: key,
      category: current === undefined ? disabled.length ? "commented_out" : "missing" : "value_changed",
      expected,
      current: typeof current === "string" || typeof current === "boolean" || typeof current === "number"
        ? current : current === undefined ? null : "[non-scalar value]",
      message: `Codex ${key} ${current === undefined ? disabled.length ? `is commented out at line${disabled.length > 1 ? "s" : ""} ${disabled.map(item => item.line).join(", ")} (inactive)` : "is missing" : "differs from the installed value"}; review the proposed repair before changing it`,
    });
  };
  for (const setting of ownedCodexScalarSettings(journal, document)) check(setting.path, setting.expected);
  if (journal.installed.subagent_protocol === "compatibility-v1") {
    if (!journal.previousMultiAgent || !journal.previousMultiAgentV2 || !journal.previousAgentMaxDepth
      || !Number.isSafeInteger(journal.installed.agent_max_depth) || journal.installed.agent_max_depth! < 2) {
      conflicts.push({ path: "journal", category: "ownership_conflict", message: "The installation journal is missing its Compatibility V1 ownership evidence" });
    }
  }
  if (journal.version === 10 && inspectCodexInterruptHook(document, journal.interruptHook) !== "valid") {
    conflicts.push({
      path: "hooks.Interrupt", category: "hook_changed",
      message: "Codex Interrupt hook identity, order, or trust differs from the installation journal; review it before repair",
    });
  }
  return conflicts;
}
