import { createHash } from "node:crypto";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { ROUTES_BEGIN, ROUTES_END } from "./codex-config-markers";

/** Discovery is deliberately separate from validation: invalid TOML has no effective winner. */
export interface ConfigurationOccurrence {
  id: string;
  path: (string | number)[];
  kind: "assignment" | "table" | "array-table" | "route-section";
  state: "active" | "commented_out";
  value?: unknown;
  line: number;
  endLine: number;
  range: [number, number];
}
export interface ConfigurationSourceDiscovery {
  complete: boolean;
  valid: boolean;
  occurrences: ConfigurationOccurrence[];
  uncertainLines: number[];
}

/** Split only outside strings/containers. Parsing each fragment remains the TOML parser's job. */
function statements(text: string): Array<{ text: string; start: number; end: number; line: number; endLine: number }> {
  const result: ReturnType<typeof statements> = [];
  let start = text.startsWith("\uFEFF") ? 1 : 0;
  let line = 1;
  let startLine = 1;
  let quote = "";
  let depth = 0;
  let comment = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    const newline = char === "\n" || char === "\r";
    if (newline) {
      const end = char === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      if (!quote && depth === 0) {
        result.push({ text: text.slice(start, i), start, end: i, line: startLine, endLine: line });
        start = end;
        startLine = line + 1;
      }
      comment = false;
      line++;
      i = end - 1;
      continue;
    }
    if (comment) continue;
    if (quote) {
      if (quote[0] === '"' && char === "\\") {
        if (text[i + 1] !== "\r" && text[i + 1] !== "\n") i++;
        continue;
      }
      if (text.startsWith(quote, i)) {
        // Four/five closing quotes include one/two literal quote characters.
        i += quote.length - 1;
        if (quote.length === 3) for (let extra = 0; extra < 2 && text[i + 1] === quote[0]; extra++) i++;
        quote = "";
      }
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'") {
      quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += quote.length - 1;
    } else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
  }
  if (start < text.length) result.push({ text: text.slice(start), start, end: text.length, line: startLine, endLine: line });
  return result;
}

const keyParts = (key: AST.TOMLKey) => key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function configurationPathName(path: readonly (string | number)[]): string {
  return path.map(part => typeof part === "number" || /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) ? String(part) : JSON.stringify(part)).join(".");
}

export function discoverConfigurationSource(text: string): ConfigurationSourceDiscovery {
  const result: ConfigurationSourceDiscovery = { complete: true, valid: true, occurrences: [], uncertainLines: [] };
  try { parseTOML(text.replace(/^\uFEFF/, "").replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" }); }
  catch { result.valid = false; }
  let scope: (string | number)[] = [];
  let scopeKnown = true;
  const arrays = new Map<string, number>();
  for (const statement of statements(text)) {
    const trimmed = statement.text.trimStart();
    if (!trimmed) continue;
    const commented = trimmed.startsWith("#");
    const fragment = commented ? trimmed.slice(1).trimStart() : statement.text;
    let ast: AST.TOMLProgram;
    try { ast = parseTOML(fragment.replace(/\r(?!\n)/g, "\n"), { tomlVersion: "1.0" }); }
    catch {
      if (!commented) {
        result.complete = false;
        result.uncertainLines.push(statement.line);
        if (trimmed.startsWith("[")) scopeKnown = false;
      }
      continue;
    }
    const entry = ast.body[0]?.body[0];
    if (!entry || ast.body[0]!.body.length !== 1) continue;
    if (commented && entry.type !== "TOMLKeyValue") continue;
    if (entry.type === "TOMLTable") {
      scope = [];
      scopeKnown = true;
      const keys = keyParts(entry.key);
      for (let i = 0; i < keys.length; i++) {
        scope.push(keys[i]!);
        const key = JSON.stringify(scope);
        if (entry.kind === "array" && i === keys.length - 1) arrays.set(key, (arrays.get(key) ?? -1) + 1);
        const index = arrays.get(key);
        if (index !== undefined) scope.push(index);
      }
    }
    if (!scopeKnown) { result.complete = false; result.uncertainLines.push(statement.line); continue; }
    const path = entry.type === "TOMLTable" ? [...scope] : [...scope, ...keyParts(entry.key)];
    result.occurrences.push({
      id: digest(JSON.stringify([statement.start, statement.end, statement.text, path])),
      path, kind: entry.type === "TOMLTable" ? entry.kind === "array" ? "array-table" : "table" : "assignment",
      state: commented ? "commented_out" : "active",
      ...(entry.type === "TOMLKeyValue" ? { value: getStaticTOMLValue(entry.value) } : {}),
      line: statement.line, endLine: statement.endLine, range: [statement.start, statement.end],
    });
  }
  // Only complete root-level pairs are selectable. Markers confer no ownership over their contents.
  let sectionStart: ReturnType<typeof statements>[number] | undefined;
  let unsafeSection = false;
  for (const statement of statements(text)) {
    if (statement.text.trim() === ROUTES_BEGIN) {
      if (sectionStart) unsafeSection = true;
      else { sectionStart = statement; unsafeSection = false; }
    } else if (statement.text.trim() === ROUTES_END && sectionStart) {
      const inScope = result.occurrences.filter(item => item.range[0] >= sectionStart!.start && item.range[0] < statement.start);
      const precedingTable = result.occurrences.some(item => (item.kind === "table" || item.kind === "array-table") && item.range[0] < statement.start);
      if (!unsafeSection && !precedingTable && inScope.every(item => item.kind === "assignment")) result.occurrences.push({
        id: digest(JSON.stringify([sectionStart.start, statement.end, text.slice(sectionStart.start, statement.end), "route-section"])),
        path: ["managed_sections", "routes"], kind: "route-section", state: "active", line: sectionStart.line, endLine: statement.endLine,
        range: [sectionStart.start, statement.end],
      });
      sectionStart = undefined;
    }
  }
  return result;
}

export interface ConfigurationResolution { occurrenceId: string }

function commentedSource(raw: string): string {
  return raw.split(/(\r\n|\r|\n)/).map((part, index) => index % 2 === 0 && part ? `# ${part}` : part).join("");
}

function consolidateTable(text: string, path: readonly (string | number)[], selectedIndex: number): string {
  if (path.some(part => typeof part === "number")) throw new Error("Array-table scopes cannot be consolidated as duplicate tables");
  const source = discoverConfigurationSource(text);
  if (!source.complete) throw new Error("Table boundaries are incomplete; review the indicated source locations");
  const tables = source.occurrences.filter(item => item.kind === "table" || item.kind === "array-table");
  const matches = tables.filter(item => item.kind === "table" && JSON.stringify(item.path) === JSON.stringify(path));
  const selected = matches[selectedIndex];
  if (!selected || matches.length < 2) throw new Error("The duplicate table selection is no longer current");
  const ending = text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
  const moved: string[] = [];
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  for (const table of matches) {
    if (table === selected) continue;
    const end = tables.find(next => next.range[0] > table.range[0])?.range[0] ?? text.length;
    const assignments = source.occurrences.filter(item => item.kind === "assignment" && item.state === "active" && item.range[0] > table.range[0] && item.range[1] <= end);
    if (assignments.some(item => !path.every((part, index) => item.path[index] === part))) throw new Error("The duplicate table contains an uncertain semantic scope; review it before consolidation");
    moved.push(...assignments.map(item => text.slice(...item.range)));
    edits.push({ start: table.range[0], end, replacement: commentedSource(text.slice(table.range[0], end)) });
  }
  if (moved.length) edits.push({ start: selected.range[1], end: selected.range[1], replacement: ending + moved.join(ending) });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

function consolidateRouteSections(text: string, selectedIndex: number): string {
  const source = discoverConfigurationSource(text);
  const sections = source.occurrences.filter(item => item.kind === "route-section");
  const selected = sections[selectedIndex];
  if (!selected || sections.length < 2) throw new Error("Bounded route section selection is no longer current");
  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  const moved: string[] = [];
  for (const section of sections) {
    if (section === selected) continue;
    const lines = statements(text).filter(item => item.start >= section.range[0] && item.end <= section.range[1]);
    for (const marker of [lines[0]!, lines.at(-1)!]) edits.push({ start: marker.start, end: marker.end, replacement: commentedSource(marker.text) });
    for (const item of source.occurrences.filter(item => item.kind === "assignment" && item.state === "active" && item.range[0] > section.range[0] && item.range[1] < section.range[1])) {
      if (item.path.length !== 1 || !["openai_base_url", "experimental_realtime_webrtc_call_base_url"].includes(String(item.path[0]))) continue;
      const raw = text.slice(...item.range);
      moved.push(raw);
      edits.push({ start: item.range[0], end: item.range[1], replacement: commentedSource(raw) });
    }
  }
  const ending = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const endMarker = statements(text).find(item => item.end === selected.range[1])!;
  if (moved.length) edits.push({ start: endMarker.start, end: endMarker.start, replacement: moved.join(ending) + ending });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  return result;
}

/** A choice retains one definition and comments competing active definitions without deleting source. */
export function resolveConfigurationSource(text: string, selections: readonly ConfigurationResolution[]): string {
  if (!selections.length) return text;
  const source = discoverConfigurationSource(text);
  if (!source.complete) throw new Error("Configuration syntax is incomplete; resolve the indicated source locations before choosing definitions");
  const edits: Array<{ range: [number, number]; replacement: string }> = [];
  const selectedPaths = new Set<string>();
  const tableChoices: Array<{ path: (string | number)[]; selectedIndex: number }> = [];
  let routeSectionChoice: number | undefined;
  for (const choice of selections) {
    const occurrence = source.occurrences.find(item => item.id === choice.occurrenceId);
    if (!occurrence) throw new Error("Configuration resolution is stale or does not identify a source definition");
    if (occurrence.kind === "array-table") throw new Error("Legitimate array-table definitions cannot be deduplicated");
    const path = JSON.stringify(occurrence.path);
    const identity = `${occurrence.kind}:${path}`;
    if (selectedPaths.has(identity)) throw new Error("Choose only one definition per setting");
    selectedPaths.add(identity);
    if (occurrence.kind === "route-section") {
      routeSectionChoice = source.occurrences.filter(item => item.kind === "route-section").findIndex(item => item.id === occurrence.id);
      continue;
    }
    if (occurrence.kind === "table") {
      tableChoices.push({ path: occurrence.path, selectedIndex: source.occurrences.filter(item => item.kind === "table" && JSON.stringify(item.path) === path).findIndex(item => item.id === occurrence.id) });
      continue;
    }
    for (const candidate of source.occurrences.filter(item => item.kind === "assignment" && JSON.stringify(item.path) === path)) {
      const raw = text.slice(...candidate.range);
      if (candidate.id === occurrence.id && candidate.state === "commented_out") {
        edits.push({ range: candidate.range, replacement: raw.replace(/^(\s*)#\s?/, "$1") });
      } else if (candidate.id !== occurrence.id && candidate.state === "active") {
        edits.push({ range: candidate.range, replacement: commentedSource(raw) });
      }
    }
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.range[0] - a.range[0])) result = result.slice(0, edit.range[0]) + edit.replacement + result.slice(edit.range[1]);
  for (const choice of tableChoices) result = consolidateTable(result, choice.path, choice.selectedIndex);
  if (routeSectionChoice !== undefined) result = consolidateRouteSections(result, routeSectionChoice);
  // Decisions can be accumulated while other duplicate groups remain; readiness belongs to final validation.
  const remaining = discoverConfigurationSource(result);
  if (!remaining.complete) throw new Error("Resolution would make configuration source ambiguous");
  return result;
}
