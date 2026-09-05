import { isDeepStrictEqual } from "node:util";
import { parseTomlValue } from "./toml-edit";
import { sha256, type FileSnapshot } from "./codex-integration-shared";
import type { CodexRepairChange } from "./contracts/codex-integration";
import { inspectCodexConfigSource, sourceAssignments } from "./codex-config-source";
import { configurationPathName, discoverConfigurationSource } from "./codex-config-occurrences";

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
  const walk = (left: unknown, right: unknown, path: (string | number)[]) => {
    if (isDeepStrictEqual(left, right)) return;
    if ((Array.isArray(left) || left === undefined) && (Array.isArray(right) || right === undefined) && (Array.isArray(left) || Array.isArray(right))) {
      for (let index = 0; index < Math.max(left?.length ?? 0, right?.length ?? 0); index++) walk(left?.[index], right?.[index], [...path, index]);
    } else if ((record(left) || left === undefined) && (record(right) || right === undefined)) {
      for (const key of new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])) walk(left?.[key], right?.[key], [...path, key]);
    } else {
      const locations = sourceAssignments(source, path.map(String));
      changes.push({ path: configurationPathName(path), current: scalar(left), proposed: scalar(right),
        currentState: left !== undefined ? "active" : locations.length ? "commented_out" : "missing",
        currentLines: locations.map(item => item.line),
      });
    }
  };
  let left: unknown;
  try { left = parseTomlValue(before); }
  catch {
    // A duplicate source has no semantic winner. Reconstruct only unambiguous leaves for comparison.
    const recovered: Record<string, unknown> = Object.create(null);
    const occurrences = discoverConfigurationSource(before).occurrences.filter(item => item.kind === "assignment" && item.state === "active");
    for (const occurrence of occurrences) {
      let parent: Record<string | number, unknown> = recovered;
      for (let index = 0; index < occurrence.path.length - 1; index++) {
        const key = occurrence.path[index]!;
        if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== "object") {
          Object.defineProperty(parent, key, { value: typeof occurrence.path[index + 1] === "number" ? [] : Object.create(null), writable: true, enumerable: true, configurable: true });
        }
        parent = parent[key] as Record<string | number, unknown>;
      }
      const matches = occurrences.filter(item => JSON.stringify(item.path) === JSON.stringify(occurrence.path));
      Object.defineProperty(parent, occurrence.path.at(-1)!, { value: matches.length === 1 ? occurrence.value : null, writable: true, enumerable: true, configurable: true });
    }
    left = recovered;
  }
  walk(left, parseTomlValue(after), []);
  return changes;
}

export function configurationApprovalId(intent: unknown, inputs: readonly FileSnapshot[], outputs: readonly { path: string; data: string }[], removals: readonly string[] = []): string {
  return sha256(JSON.stringify({ version: 1, intent,
    inputs: inputs.map(file => [file.path, file.exists, file.data ? sha256(file.data) : null]),
    outputs: outputs.map(file => [file.path, sha256(file.data)]), removals,
  }));
}
