import { AttributesSchema, DiagnosticEventSchema, ProblemSchema, type DiagnosticEvent, type Problem } from "./contracts";

const PRIVATE_KEY = /(?:authorization|cookie|password|credential|secret|token|runtime.?key|control.?token|prompt|response|payload|html|dom|content|screenshot|storage.?state|visible.?rows|sidebar|conversation.?title|chat.?title)/i;
const SAFE_COUNT = /(?:chars|count|bytes|tokens|duration|latency|status|code|id|length|completed|trimmed)$/i;

export function safeText(value: string, exportMode = false): string {
  if (/strict mode violation|\blocator\.[A-Za-z]+:|<\/?(?:a|div|span|textarea|input|button)\b/i.test(value)) {
    return /strict mode violation/i.test(value) ? "Browser control matched multiple elements; rendered content omitted" : "Browser interaction failed; rendered content omitted";
  }
  let result = value
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[credential]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/((?:password|api[_-]?key|runtime[_-]?key|access[_-]?token|control[_-]?token|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'`<>]+/gi, candidate => {
      try { return new URL(candidate).origin; } catch { return "[url]"; }
    });
  if (exportMode) result = result.replace(/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n"'`<>|]+/gi, "[user-home]")
    .replace(/\/(?:Users|home)\/[^/\r\n"'`<> ]+/g, "[user-home]");
  return result.length > 4096 ? `${result.slice(0, 4048)}…[truncated]` : result;
}

export function safeAttributes(input: unknown, exportMode = false): DiagnosticEvent["attributes"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result: DiagnosticEvent["attributes"] = {};
  for (const [key, value] of Object.entries(input).slice(0, 64)) {
    if (key.length > 160 || (PRIVATE_KEY.test(key) && !(SAFE_COUNT.test(key) && typeof value === "number"))) continue;
    if (exportMode && /(?:task.?name|title|path|file|directory|home|command|args)/i.test(key)) continue;
    if (typeof value === "string") result[key] = safeText(value, exportMode);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (Array.isArray(value)) {
      const items: (string | number | boolean)[] = [];
      for (const item of value.slice(0, 64)) {
        if (typeof item === "string") items.push(safeText(item, exportMode).slice(0, 512));
        else if (typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) items.push(item);
      }
      result[key] = items;
    }
  }
  return AttributesSchema.parse(result);
}

/** Legacy fields have no content-safety contract. Retain only bounded structural evidence. */
export function safeLegacyAttributes(input: unknown): DiagnosticEvent["attributes"] {
  return Object.fromEntries(Object.entries(safeAttributes(input)).filter(([key, value]) =>
    typeof value === "number" || typeof value === "boolean" ||
    /^(?:phase|stage|component|version|code|signal|method|channel|connector)$/.test(key) && typeof value === "string" && /^[\w .:-]{1,128}$/.test(value)));
}

export function safeProblem(input: Problem, exportMode = false): Problem {
  return ProblemSchema.parse({ ...input, message: safeText(input.message, exportMode),
    findings: input.findings.map(item => ({ ...(item.path ? { path: exportMode ? "[configuration setting]" : safeText(item.path) } : {}), message: safeText(item.message, exportMode) })),
    causes: input.causes.map(item => ({ code: item.code, message: safeText(item.message, exportMode) })),
  });
}

export function sanitizeEvent(input: unknown, exportMode = false): DiagnosticEvent {
  const safe = DiagnosticEventSchema.parse(input);
  safe.name = safeText(safe.name, exportMode); safe.body = safeText(safe.body, exportMode);
  safe.target = exportMode ? "[target]" : safeText(safe.target);
  safe.taskName = exportMode ? undefined : safe.taskName ? safeText(safe.taskName) : undefined;
  safe.attributes = safeAttributes(safe.attributes, exportMode);
  if (safe.kind === "problem") safe.problem = safeProblem(safe.problem, exportMode);
  // Bound complete records, not only individual fields: a large finding list cannot overwhelm IPC.
  const encodedBytes = () => new TextEncoder().encode(JSON.stringify(safe)).byteLength;
  if (encodedBytes() > 12 * 1024) {
    safe.attributes = { "diagnostics.truncated": true };
    while (safe.problem?.findings.length && encodedBytes() > 12 * 1024) safe.problem.findings.pop();
    while (safe.problem?.causes.length && encodedBytes() > 12 * 1024) safe.problem.causes.pop();
    if (encodedBytes() > 12 * 1024) { safe.body = safe.body.slice(0, 1024); if (safe.problem) safe.problem.message = safe.problem.message.slice(0, 1024); }
  }
  return safe;
}
