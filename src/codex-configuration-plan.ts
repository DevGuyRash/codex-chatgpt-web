import { isDeepStrictEqual } from "node:util";
import { parseTomlValue } from "./toml-edit";
import { sha256, type FileSnapshot } from "./codex-integration-shared";
import type { CodexRepairChange } from "./contracts/codex-integration";
import { inspectCodexConfigSource, sourceAssignments } from "./codex-config-source";

export function describeCodexSourceChange(path: string, before: string, after: string) {
  if (before === after) return [];
  const oldLines = before.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)!.filter(Boolean);
  const newLines = after.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)!.filter(Boolean);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix++;
  return [{ path, startLine: prefix + 1, before: oldLines.slice(prefix, oldLines.length - suffix).join(""), after: newLines.slice(prefix, newLines.length - suffix).join("") }];
}

/** The review contract is derived from prepared output, never a second implementation of edits. */
export function describeCodexConfigurationChanges(before: string, after: string): CodexRepairChange[] {
  const changes: CodexRepairChange[] = [];
  const source = inspectCodexConfigSource(before);
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
  const scalar = (value: unknown): string | number | boolean | null => value === undefined ? null
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);
  const walk = (left: unknown, right: unknown, path: string[]) => {
    if (isDeepStrictEqual(left, right)) return;
    if ((record(left) || left === undefined) && (record(right) || right === undefined)) {
      for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) walk(left?.[key], right?.[key], [...path, key]);
    } else {
      const locations = sourceAssignments(source, path);
      changes.push({ path: path.join("."), current: scalar(left), proposed: scalar(right),
        currentState: left !== undefined ? "active" : locations.length ? "commented_out" : "missing",
        currentLines: locations.map(item => item.line),
      });
    }
  };
  walk(parseTomlValue(before), parseTomlValue(after), []);
  return changes;
}

export function configurationApprovalId(intent: unknown, inputs: readonly FileSnapshot[], outputs: readonly { path: string; data: string }[], removals: readonly string[] = []): string {
  return sha256(JSON.stringify({ version: 1, intent,
    inputs: inputs.map(file => [file.path, file.exists, file.data ? sha256(file.data) : null]),
    outputs: outputs.map(file => [file.path, sha256(file.data)]), removals,
  }));
}
