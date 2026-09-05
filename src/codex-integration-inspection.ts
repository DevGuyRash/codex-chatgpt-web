import { stripUtf8Bom } from "./config";
import { codexInterruptHookHash } from "./codex-interrupt-hook";
import type { AnyCodexIntegrationJournal } from "./codex-integration-shared";

/** Structured inspection evidence, not permission to overwrite the user's configuration. */
export interface CodexIntegrationConflict {
  path: string;
  category: "missing" | "value_changed" | "hook_changed" | "invalid_config" | "ownership_conflict";
  message: string;
  expected?: string | number | boolean;
  current?: string | number | boolean | null;
}

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

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    const record = table(item);
    return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]])) : item;
  });
}

/** Parse once and compare owned values, independent of comments and TOML layout. No writes. */
export function inspectInstalledCodexConfig(text: string, journal: InspectableJournal): CodexIntegrationConflict[] {
  let document: Table;
  try {
    const parsed = table(Bun.TOML.parse(stripUtf8Bom(text)));
    if (!parsed) throw new Error("Expected TOML document");
    document = parsed;
  } catch {
    // Parser exceptions can quote arbitrary private configuration text.
    return [{ path: "config", category: "invalid_config", message: "Codex configuration is not valid, unambiguous TOML; inspect it before attempting repair" }];
  }
  const conflicts: CodexIntegrationConflict[] = [];
  const check = (path: string[], expected: string | boolean | number): void => {
    const current = at(document, path);
    if (current === expected) return;
    const key = path.join(".");
    conflicts.push({
      path: key,
      category: current === undefined ? "missing" : "value_changed",
      expected,
      current: typeof current === "string" || typeof current === "boolean" || typeof current === "number"
        ? current : current === undefined ? null : "[non-scalar value]",
      message: `Codex ${key} ${current === undefined ? "is missing" : "differs from the installed value"}; review the proposed repair before changing it`,
    });
  };
  check(["openai_base_url"], journal.installed.openai_base_url);
  if (journal.version === 9 || journal.version === 10) {
    check(["experimental_realtime_webrtc_call_base_url"], journal.installed.experimental_realtime_webrtc_call_base_url);
  }
  if (journal.installed.subagent_protocol === "compatibility-v1") {
    if (!journal.previousMultiAgent || !journal.previousMultiAgentV2 || !journal.previousAgentMaxDepth
      || !Number.isSafeInteger(journal.installed.agent_max_depth) || journal.installed.agent_max_depth! < 2) {
      conflicts.push({ path: "journal", category: "ownership_conflict", message: "The installation journal is missing its Compatibility V1 ownership evidence" });
    } else {
      check(["features", "multi_agent"], true);
      const v2 = at(document, ["features", "multi_agent_v2"]);
      // Both Codex's legacy boolean and its structured feature syntax describe the same flag.
      check(table(v2) ? ["features", "multi_agent_v2", "enabled"] : ["features", "multi_agent_v2"], false);
      check(["agents", "max_depth"], journal.installed.agent_max_depth!);
    }
  }
  if (journal.version === 10) {
    const installed = journal.interruptHook;
    let matches = false;
    try {
      const groups = at(document, ["hooks", "Interrupt"]);
      const state = at(document, ["hooks", "state", installed.stateKey]);
      const normalizeGroup = (group: unknown): unknown => {
        const record = table(group);
        if (!record || !Array.isArray(record.hooks)) return group;
        return { ...record, hooks: record.hooks.map((hook: unknown) => {
          const entry = table(hook);
          return entry ? { ...entry, async: entry.async ?? false } : hook;
        }) };
      };
      const expectedGroup = { hooks: [{ type: "command", command: installed.command, timeout: 3, async: false }] };
      const commandOccurrences = Array.isArray(groups) ? groups.flatMap(group => {
        const hooks = table(group)?.hooks;
        return Array.isArray(hooks) ? hooks : [];
      }).filter(hook => table(hook)?.command === installed.command).length : 0;
      matches = Array.isArray(groups)
        && canonical(normalizeGroup(groups[installed.groupIndex])) === canonical(expectedGroup)
        && canonical(state) === canonical({ trusted_hash: installed.trustedHash })
        && commandOccurrences === 1
        && codexInterruptHookHash(installed.command) === installed.trustedHash;
    } catch { /* Malformed ownership evidence must never establish authority. */ }
    if (!matches) conflicts.push({
      path: "hooks.Interrupt", category: "hook_changed",
      message: "Codex Interrupt hook identity, order, or trust differs from the installation journal; review it before repair",
    });
  }
  return conflicts;
}
