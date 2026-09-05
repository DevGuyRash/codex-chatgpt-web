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
function prefix(left: readonly (string | number)[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((key, index) => key === right[index]);
}
function keys(key: AST.TOMLKey): string[] {
  return key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value);
}
function parse(text: string): { ast: AST.TOMLProgram; value: Table } {
  try {
    // Replacing lone CR preserves offsets; edits are always applied to the original bytes.
    const input = stripUtf8Bom(text).replace(/\r(?!\n)/g, "\n");
    const value: unknown = Bun.TOML.parse(input);
    if (!table(value)) throw new Error();
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
  if (value === undefined) delete expected[last];
  else Object.defineProperty(expected, last, { value, enumerable: true, configurable: true, writable: true });

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
  if (target && value === undefined) {
    [start, end] = target.range;
    replacement = "";
    if (target.parent.type === "TOMLInlineTable") {
      const siblings = target.parent.body;
      const index = siblings.indexOf(target);
      const next = siblings[index + 1];
      const previous = siblings[index - 1];
      const comma = parsed.ast.tokens.find(token => token.value === ","
        && (next ? token.range[0] >= end && token.range[1] <= next.range[0]
          : previous ? token.range[0] >= previous.range[1] && token.range[1] <= start : false));
      if (comma && next) end = comma.range[1];
      else if (comma) start = comma.range[0];
    }
  } else if (target) {
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
