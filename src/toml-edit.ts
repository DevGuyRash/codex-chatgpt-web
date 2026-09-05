import { isDeepStrictEqual } from "node:util";
import { parseTOML, type AST } from "toml-eslint-parser";
import { stripUtf8Bom } from "./config";

type Table = Record<string, unknown>;
function table(value: unknown): value is Table {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}
function own(value: Table, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}
function prefix(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length <= right.length && left.every((key, index) => key === right[index]);
}

/** Remove an explicitly owned subtree. Callers must prove ownership before using this edit. */
export function removeTomlPath(text: string, path: readonly (string | number)[]): string {
  if (!path.length) throw new Error("Cannot remove the configuration root");
  const parsed = parse(text);
  const get = (value: unknown, key: string | number): unknown => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    return (value as Record<string | number, unknown>)[key];
  };
  const at = (value: unknown, parts: readonly (string | number)[]): unknown => parts.reduce(get, value);
  const parent = at(parsed.value, path.slice(0, -1));
  const last = path.at(-1)!;
  if (get(parent, last) === undefined) return text;
  if (Array.isArray(parent) && typeof last === "number") parent.splice(last, 1);
  else if (table(parent) && typeof last === "string") delete parent[last];
  else throw new Error("Invalid configuration removal path");
  const selected = new Set<AST.TOMLNode>();
  const ranges: Array<[number, number]> = [];
  const add = (node: AST.TOMLKeyValue | AST.TOMLTable | AST.TOMLContentNode): void => {
    selected.add(node);
  };
  const range = (node: AST.TOMLNode): void => {
    let [start, end] = node.range;
    if (node.parent?.type === "TOMLInlineTable" || node.parent?.type === "TOMLArray") {
      const siblings: AST.TOMLNode[] = node.parent.type === "TOMLArray" ? node.parent.elements : node.parent.body;
      const index = siblings.indexOf(node);
      const previous = siblings[index - 1];
      if (previous && selected.has(previous)) return;
      let lastIndex = index;
      while (siblings[lastIndex + 1] && selected.has(siblings[lastIndex + 1]!)) lastIndex++;
      end = siblings[lastIndex]!.range[1];
      const next = siblings[lastIndex + 1];
      const comma = parsed.ast.tokens.find(token => token.value === ","
        && (next ? token.range[0] >= end && token.range[1] <= next.range[0]
          : previous ? token.range[0] >= previous.range[1] && token.range[1] <= start : false));
      if (comma && next) end = comma.range[1];
      else if (comma) start = comma.range[0];
    }
    ranges.push([start, end]);
  };
  const content = (node: AST.TOMLContentNode, resolved: (string | number)[]): void => {
    if (node.parent.type === "TOMLArray" && prefix(path, resolved)) { add(node); return; }
    if (node.type === "TOMLInlineTable") node.body.forEach(entry => visit(entry, resolved));
    else if (node.type === "TOMLArray") node.elements.forEach((entry, index) => content(entry, [...resolved, index]));
  };
  const visit = (entry: AST.TOMLKeyValue, base: (string | number)[]): void => {
    const resolved = [...base, ...keys(entry.key)];
    if (prefix(path, resolved)) { add(entry); return; }
    content(entry.value, resolved);
  };
  for (const entry of parsed.ast.body[0].body) {
    if (entry.type === "TOMLKeyValue") visit(entry, []);
    else if (prefix(path, entry.resolvedKey)) add(entry);
    else entry.body.forEach(child => visit(child, entry.resolvedKey));
  }
  selected.forEach(range);
  if (!ranges.length) throw new Error("Could not identify the owned configuration subtree");
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  let result = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) result = result.slice(0, start + bom) + result.slice(end + bom);
  const actual = parse(result).value;
  // Removing the final array-table header can also remove its implicit empty ancestors.
  // Ignore only empty ancestors along this removal path, never unrelated settings.
  const prune = (root: Table): void => {
    for (let depth = path.length - 1; depth > 0; depth--) {
      const branch = at(root, path.slice(0, depth));
      if ((!table(branch) && !Array.isArray(branch)) || Object.keys(branch).length) continue;
      const owner = at(root, path.slice(0, depth - 1));
      if (table(owner)) delete owner[String(path[depth - 1])];
    }
  };
  prune(actual);
  prune(parsed.value);
  if (!isDeepStrictEqual(actual, parsed.value)) throw new Error("Configuration removal changed unrelated values; no changes were made");
  return result;
}

/** Remove only actual TOML comments, never lookalike lines inside multiline strings. */
export function removeTomlComments(text: string, comments: readonly string[]): string {
  const parsed = parse(text);
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  let result = text;
  for (const comment of [...parsed.ast.comments].reverse()) {
    const [start, end] = comment.range;
    if (comments.includes(text.slice(start + bom, end + bom))) result = result.slice(0, start + bom) + result.slice(end + bom);
  }
  if (!isDeepStrictEqual(parse(result).value, parsed.value)) throw new Error("Comment removal changed configuration values");
  return result;
}
function keys(key: AST.TOMLKey): string[] {
  return key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
}
export function parseTomlValue(text: string): Table {
  try {
    const value: unknown = Bun.TOML.parse(stripUtf8Bom(text).replace(/\r(?!\n)/g, "\n"));
    if (!table(value)) throw new Error();
    return value;
  } catch { throw new Error("Invalid TOML or unsupported syntax; no configuration changes were made"); }
}
function parse(text: string): { ast: AST.TOMLProgram; value: Table } {
  try {
    // Replacing lone CR preserves offsets; edits are always applied to the original bytes.
    const input = stripUtf8Bom(text).replace(/\r(?!\n)/g, "\n");
    const value = parseTomlValue(text);
    return { ast: parseTOML(input, { tomlVersion: "1.0" }), value };
  } catch {
    throw new Error("Invalid TOML or unsupported syntax; no configuration changes were made");
  }
}

/** Edit one scalar by syntax range, with an independent semantic check of all other values. */
export function setTomlScalar(text: string, path: readonly string[], value: string | number | boolean | undefined): string {
  if (path.length === 0 || path.some(key => typeof key !== "string")
    || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Invalid scalar edit");
  const parsed = parse(text);
  let expected = parsed.value;
  for (const key of path.slice(0, -1)) {
    let child = own(expected, key);
    if (child === undefined) {
      if (value === undefined) return text;
      child = {};
      Object.defineProperty(expected, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    if (!table(child)) throw new Error("Cannot add a setting beneath a non-table value");
    expected = child;
  }
  const last = path.at(-1)!;
  const current = own(expected, last);
  if (current === value) return text;
  if (current !== undefined && !["string", "boolean", "number"].includes(typeof current)) {
    throw new Error("Cannot replace a non-scalar setting with a scalar");
  }
  if (value === undefined) return removeTomlPath(text, path);
  Object.defineProperty(expected, last, { value, enumerable: true, configurable: true, writable: true });

  let target: AST.TOMLKeyValue | undefined;
  let container: { path: (string | number)[]; node: AST.TOMLInlineTable | AST.TOMLTable } | undefined;
  const consider = (node: AST.TOMLInlineTable | AST.TOMLTable, resolved: (string | number)[]): void => {
    if (resolved.length < path.length && prefix(resolved, path)
      && (!container || resolved.length > container.path.length)) container = { path: resolved, node };
  };
  const visit = (entry: AST.TOMLKeyValue, base: (string | number)[]): void => {
    const resolved = [...base, ...keys(entry.key)];
    if (resolved.length === path.length && prefix(resolved, path)) {
      if (target) throw new Error("Ambiguous setting; no configuration changes were made");
      target = entry;
    }
    if (entry.value.type === "TOMLInlineTable") {
      consider(entry.value, resolved);
      entry.value.body.forEach(child => visit(child, resolved));
    }
  };
  for (const entry of parsed.ast.body[0].body) {
    if (entry.type === "TOMLKeyValue") visit(entry, []);
    else {
      consider(entry, entry.resolvedKey);
      entry.body.forEach(child => visit(child, entry.resolvedKey));
    }
  }
  const bom = text.startsWith("\uFEFF") ? 1 : 0;
  const encoded = JSON.stringify(value);
  let start: number;
  let end: number;
  let replacement: string;
  if (target) {
    [start, end] = target.value.range;
    replacement = encoded!;
  } else {
    const relative = path.slice(container?.path.length ?? 0)
      .map(key => /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)).join(".");
    const assignment = `${relative} = ${encoded}`;
    if (container?.node.type === "TOMLInlineTable") {
      start = end = container.node.body.at(-1)?.range[1] ?? container.node.range[1] - 1;
      replacement = `${container.node.body.length ? ", " : ""}${assignment}`;
    } else {
      const ending = text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
      const entries = parsed.ast.body[0].body;
      const next = container ? entries[entries.indexOf(container.node) + 1] : entries.find(entry => entry.type === "TOMLTable");
      start = end = next?.range[0] ?? text.length - bom;
      replacement = `${start > 0 && !/[\r\n]/.test(text[bom + start - 1]!) ? ending : ""}${assignment}${ending}`;
    }
  }
  const result = text.slice(0, start + bom) + replacement + text.slice(end + bom);
  if (!isDeepStrictEqual(parse(result).value, parsed.value)) {
    throw new Error("Configuration edit did not preserve unrelated values; no changes were made");
  }
  return result;
}
