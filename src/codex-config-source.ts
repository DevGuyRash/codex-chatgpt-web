import { parseTOML, type AST } from "toml-eslint-parser";
import { stripUtf8Bom } from "./config";
import { parseTomlValue, setTomlScalar } from "./toml-edit";
import { isDeepStrictEqual } from "node:util";
import { MANAGED_COMMENT, MANAGED_ROUTE_COMMENT, ROUTES_BEGIN, ROUTES_END, MANAGED_INTERRUPT_HOOK_START as hookBegin, MANAGED_INTERRUPT_HOOK_END as hookEnd } from "./codex-config-markers";
export { ROUTES_BEGIN, ROUTES_END } from "./codex-config-markers";
import type { CodexConfigScalar, CodexIntegrationConflict } from "./contracts/codex-integration";

const legacyRoutes = [MANAGED_ROUTE_COMMENT, MANAGED_COMMENT];
const routeKeys = new Set(["openai_base_url", "experimental_realtime_webrtc_call_base_url"]);

export interface CodexSourceAssignment {
  path: string[];
  state: "active" | "commented_out";
  value: CodexConfigScalar;
  line: number;
  range: [number, number];
  section?: "routes" | "interrupt" | "legacy-routes";
}
export interface CodexSourceInventory {
  assignments: CodexSourceAssignment[];
  conflicts: CodexIntegrationConflict[];
  sections: Array<{ kind: "routes" | "interrupt" | "legacy-routes"; start: number; end: number; line: number }>;
}
const keyParts = (key: AST.TOMLKey) => key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
const isScalar = (value: unknown): value is CodexConfigScalar => ["string", "boolean", "number"].includes(typeof value);
const at = (value: unknown, path: readonly (string | number)[]): unknown => path.reduce((item, key) =>
  item && typeof item === "object" && Object.hasOwn(item, key) ? (item as Record<string | number, unknown>)[key] : undefined, value);

/** Source evidence only. Comments and delimiters never establish installation ownership. */
export function inspectCodexConfigSource(text: string): CodexSourceInventory {
  const result: CodexSourceInventory = { assignments: [], conflicts: [], sections: [] };
  const input = stripUtf8Bom(text).replace(/\r(?!\n)/g, "\n");
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  let ast: AST.TOMLProgram;
  let values: ReturnType<typeof parseTomlValue>;
  try { ast = parseTOML(input, { tomlVersion: "1.0" }); values = parseTomlValue(text); }
  catch (error) {
    // Never return parser excerpts, which may contain private values.
    const duplicate = error instanceof Error && /Defining a key multiple times/.test(error.message);
    const line = (error as { lineNumber?: unknown })?.lineNumber;
    result.conflicts.push({ path: "config", category: "invalid_config", message: duplicate
      ? `Codex configuration contains a duplicate key or table${Number.isSafeInteger(line) ? ` at line ${line}` : ""}; resolve the competing definitions before repair`
      : "Codex configuration is not valid, unambiguous TOML; inspect it before attempting repair" });
    return result;
  }
  const entries = ast.body[0]!.body;
  const tables = entries.filter((entry): entry is AST.TOMLTable => entry.type === "TOMLTable");
  const scopeAt = (offset: number) => tables.findLast(entry => entry.range[0] < offset)?.resolvedKey ?? [];
  const add = (entry: AST.TOMLKeyValue, base: (string | number)[]): void => {
    const path = [...base, ...keyParts(entry.key)];
    const value = at(values, path);
    if (isScalar(value) && path.every(part => typeof part === "string")) result.assignments.push({
      path: path as string[], state: "active", value, line: entry.loc.start.line,
      range: [entry.range[0] + bom, entry.range[1] + bom],
    });
    if (entry.value.type === "TOMLInlineTable") entry.value.body.forEach(child => add(child, path));
  };
  for (const entry of entries) {
    if (entry.type === "TOMLKeyValue") add(entry, []);
    else entry.body.forEach(child => add(child, entry.resolvedKey));
  }
  type Section = { kind: "routes" | "interrupt" | "legacy-routes"; start: number; end: number; line: number };
  const sections: Section[] = result.sections;
  let opened: Section | undefined;
  const issue = (message: string) => result.conflicts.push({ path: "managed_sections", category: "ownership_conflict", message });
  for (const comment of ast.comments) {
    const raw = input.slice(...comment.range);
    const line = comment.loc.start.line;
    // Inline comments do not delimit sections or represent disabled assignments.
    const lineStart = input.lastIndexOf("\n", comment.range[0] - 1) + 1;
    if (input.slice(lineStart, comment.range[0]).trim()) continue;
    const begin = raw === ROUTES_BEGIN ? "routes" : raw === hookBegin ? "interrupt" : undefined;
    const end = raw === ROUTES_END ? "routes" : raw === hookEnd ? "interrupt" : undefined;
    if (begin) {
      if (opened) issue(`Nested managed section at line ${line}; section boundaries need review`);
      opened = { kind: begin, start: comment.range[1] + bom, end: text.length, line };
      sections.push(opened);
      if (begin === "routes" && scopeAt(comment.range[0]).length) issue(`Managed routes begin inside a TOML table at line ${line}; comment markers do not reset table scope`);
    } else if (end) {
      if (!opened || opened.kind !== end) issue(`Unmatched managed section end at line ${line}; section boundaries need review`);
      else { opened.end = comment.range[0] + bom; opened = undefined; }
    } else if (legacyRoutes.includes(raw)) {
      if (opened) issue(`Legacy route header occurs inside a bounded managed section at line ${line}`);
      sections.push({ kind: "legacy-routes", start: comment.range[1] + bom,
        end: (tables.find(entry => entry.range[0] > comment.range[0])?.range[0] ?? input.length) + bom, line });
    } else {
      try {
        const fragment = comment.value.trimStart();
        const parsed = parseTOML(fragment, { tomlVersion: "1.0" });
        const entry = parsed.body[0]!.body[0];
        if (parsed.body[0]!.body.length !== 1 || entry?.type !== "TOMLKeyValue") continue;
        const path = keyParts(entry.key);
        const value = at(parseTomlValue(fragment), path);
        const scope = scopeAt(comment.range[0]);
        if (isScalar(value) && scope.every(part => typeof part === "string")) result.assignments.push({
          path: [...scope as string[], ...path], state: "commented_out", value, line,
          range: [comment.range[0] + bom, comment.range[1] + bom],
        });
      } catch { /* Ordinary prose and incomplete examples are not assignments. */ }
    }
  }
  if (opened) issue(`Managed ${opened.kind} section at line ${opened.line} has no end marker; do not infer the rest of the file is owned`);
  for (const kinds of [["routes", "legacy-routes"], ["interrupt"]]) {
    const matches = sections.filter(section => kinds.includes(section.kind));
    if (matches.length > 1) issue(`Multiple managed ${kinds[0]} sections at lines ${matches.map(section => section.line).join(", ")}; choose the intended section before consolidation`);
  }
  for (const assignment of result.assignments) {
    assignment.section = sections.find(section => assignment.range[0] >= section.start && assignment.range[1] <= section.end)?.kind;
    if (assignment.state === "active" && assignment.path.length === 1 && routeKeys.has(assignment.path[0]!)
      && sections.some(section => section.kind === "routes") && assignment.section !== "routes") {
      issue(`Active ${assignment.path[0]} at line ${assignment.line} is outside the bounded routes section; review it before relocating or replacing it`);
    }
  }
  for (const section of sections.filter(section => section.kind === "routes")) {
    if (tables.some(entry => entry.range[0] + bom > section.start && entry.range[0] + bom < section.end)) {
      issue(`Managed routes section at line ${section.line} crosses a TOML table boundary`);
    }
  }
  return result;
}

export function sourceAssignments(inventory: CodexSourceInventory, path: readonly string[]): CodexSourceAssignment[] {
  return inventory.assignments.filter(item => item.path.length === path.length && item.path.every((part, index) => part === path[index]));
}

/** An approved caller may reactivate one unambiguous commented scalar in a tracked section. */
export function setTrackedCodexScalar(text: string, path: readonly string[], value: CodexConfigScalar | undefined): string {
  const inventory = inspectCodexConfigSource(text);
  if (inventory.conflicts.length) throw new Error(inventory.conflicts.map(issue => issue.message).join("; "));
  const matches = sourceAssignments(inventory, path);
  const disabled = matches.filter(item => item.state === "commented_out" && item.section);
  if (value !== undefined && !matches.some(item => item.state === "active") && disabled.length) {
    if (disabled.length !== 1) throw new Error(`Multiple commented assignments for ${path.join(".")}; review which one to reactivate`);
    const candidate = disabled[0]!;
    const [start, end] = candidate.range;
    const enabled = text.slice(0, start) + text.slice(start, end).replace(/^#\s?/, "") + text.slice(end);
    // The normal semantic editor verifies the requested change and preserves every sibling value.
    return setTomlScalar(enabled, path, value);
  }
  const routes = inventory.sections.find(section => section.kind === "routes");
  if (value !== undefined && routes && path.length === 1 && routeKeys.has(path[0]!) && !matches.some(item => item.state === "active")) {
    const ending = text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
    const result = text.slice(0, routes.end) + `${JSON.stringify(path[0])} = ${JSON.stringify(value)}${ending}` + text.slice(routes.end);
    if (!isDeepStrictEqual(parseTomlValue(result), parseTomlValue(setTomlScalar(text, path, value)))) throw new Error("Route insertion changed unrelated settings");
    return result;
  }
  return setTomlScalar(text, path, value);
}

/** Bound only the two root route assignments, preserving their spelling and inline comments. */
export function boundCodexRouteSection(text: string): string {
  const inventory = inspectCodexConfigSource(text);
  if (inventory.conflicts.length) throw new Error(inventory.conflicts.map(issue => issue.message).join("; "));
  const roots = inventory.assignments.filter(item => item.state === "active" && item.path.length === 1 && routeKeys.has(item.path[0]!));
  if (roots.length !== routeKeys.size) throw new Error("Both active route assignments are required before creating a bounded routes section");
  if (roots.every(item => item.section === "routes")) return text;
  let result = text;
  const markerLines = new Set(inventory.sections.filter(section => section.kind === "legacy-routes").map(section => section.line));
  if (markerLines.size) result = (text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [])
    .filter((_line, index) => !markerLines.has(index + 1)).join("");
  if (text.startsWith("\uFEFF") && !result.startsWith("\uFEFF")) result = "\uFEFF" + result;
  const assignments = inspectCodexConfigSource(result).assignments.filter(item => item.state === "active" && item.path.length === 1 && routeKeys.has(item.path[0]!)).sort((a, b) => a.range[0] - b.range[0]);
  const ending = result.includes("\r\n") ? "\r\n" : result.includes("\n") ? "\n" : result.includes("\r") ? "\r" : "\n";
  const ranges = assignments.map(item => {
    const start = Math.max(result.lastIndexOf("\n", item.range[0] - 1), result.lastIndexOf("\r", item.range[0] - 1)) + 1;
    const suffix = /\r\n|\n|\r/.exec(result.slice(item.range[1]));
    const end = suffix ? item.range[1] + suffix.index + suffix[0].length : result.length;
    return { start: Math.max(start, result.startsWith("\uFEFF") ? 1 : 0), end };
  });
  const fragments = ranges.map(({ start, end }) => result.slice(start, end).replace(/(?:\r\n|\n|\r)$/, ""));
  const insertAt = ranges[0]!.start;
  for (const { start, end } of [...ranges].reverse()) result = result.slice(0, start) + result.slice(end);
  result = result.slice(0, insertAt) + [ROUTES_BEGIN, ...fragments, ROUTES_END, ""].join(ending) + result.slice(insertAt);
  if (!isDeepStrictEqual(parseTomlValue(text), parseTomlValue(result))) throw new Error("Route section layout changed configuration values; no changes were applied");
  return result;
}
