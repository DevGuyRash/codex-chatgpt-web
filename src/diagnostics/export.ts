import { lstatSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { ExportOptionsSchema, type DiagnosticEvent, type DiagnosticStatus, type ExportOptions } from "./contracts";
import { privateDirectory } from "./store";
import { assembleReport } from "./report";
import { canonicalDestination, containsPath, writeExport } from "./paths";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
function otlpValue(value: unknown): object {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(otlpValue) } };
  return { stringValue: String(value) };
}
function attributes(value: Record<string, unknown>) { return Object.entries(value).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value: otlpValue(value) })); }
const nanos = (time: number) => String(BigInt(Math.round(time * 1000)) * 1000n);

export function toOtlp(events: DiagnosticEvent[]) {
  const key = (event: DiagnosticEvent) => JSON.stringify([event.component, event.attributes["service.version"] ?? "unknown", event.environment]);
  const groups = [...new Map(events.map(event => [key(event), { component: event.component, version: event.attributes["service.version"] ?? "unknown", environment: event.environment, key: key(event) }])).values()];
  const resource = (group: typeof groups[number]) => ({ attributes: attributes({ "service.name": `codex-web-gpt.${group.component}`, "service.version": group.version, "deployment.environment.name": group.environment }) });
  return {
    logs: { resourceLogs: groups.map(group => ({ resource: resource(group), scopeLogs: [{ scope: { name: "codex-web-gpt.diagnostics", version: "1" }, logRecords: events.filter(event => key(event) === group.key).map(event => ({
      timeUnixNano: nanos(event.time), observedTimeUnixNano: nanos(event.time), severityNumber: { debug: 5, info: 9, warning: 13, error: 17 }[event.severity], severityText: event.severity.toUpperCase(),
      body: { stringValue: event.body }, eventName: event.name, traceId: event.traceId, spanId: event.spanId,
      attributes: attributes({ ...event.attributes, "diagnostics.event_id": event.id, "diagnostics.environment": event.environment, "diagnostics.task_id": event.taskId }),
    })) }] })) },
    traces: { resourceSpans: groups.map(group => ({ resource: resource(group), scopeSpans: [{ scope: { name: "codex-web-gpt.diagnostics", version: "1" }, spans: events.filter(event => key(event) === group.key && event.span?.endTime !== undefined && event.traceId && event.spanId).map(event => ({
      traceId: event.traceId, spanId: event.spanId, parentSpanId: event.parentSpanId, name: event.name, kind: 1,
      startTimeUnixNano: nanos(event.span!.startTime), endTimeUnixNano: nanos(event.span!.endTime!),
      attributes: attributes({ ...event.attributes, "diagnostics.outcome": event.span!.outcome }), status: { code: event.span!.outcome === "failed" ? 2 : ["succeeded", "recovered"].includes(event.span!.outcome) ? 1 : 0 },
    })) }] })) },
  };
}

export function renderReport(events: DiagnosticEvent[], notices: string[], context?: { versions: string[]; collectionHealth: DiagnosticStatus; incomplete: boolean }): string {
  const operations = events.filter(event => event.span && !event.parentSpanId);
  const failures = events.filter(event => event.kind === "problem");
  const health = context?.collectionHealth;
  const summary = context && health ? `<h2>Collection health</h2><p>${health.available ? "Storage available" : "Storage unavailable"} · ${health.dropped} dropped records · ${health.bytes} bytes retained · ${context.incomplete ? "Incomplete selection" : "No collection gaps reported for this selection"}</p><p>Retention: ${health.retention.days} days / ${health.retention.bytes} bytes. Counts describe the collection at export time, not continuing health.</p><h2>Component versions</h2><ul>${context.versions.map(version => `<li>${escapeHtml(version)}</li>`).join("")}</ul>` : "<p>Collection health and component versions were not supplied.</p>";
  const row = (event: DiagnosticEvent) => `<article><header><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.span?.outcome ?? event.severity)}</span></header><p>${escapeHtml(event.body)}</p><small>${escapeHtml(new Date(event.time).toISOString())} · ${escapeHtml(event.component)}</small>${event.problem ? `<p>${escapeHtml(event.problem.message)}</p><p>Recovery: ${escapeHtml(event.problem.recovery)}</p>` : ""}<details><summary>Technical details</summary><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></details></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Codex Web GPT diagnostic report</title><style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:1000px;margin:auto;padding:clamp(12px,3vw,32px);line-height:1.6}article{border:1px solid GrayText;border-radius:10px;padding:16px;margin:12px 0}header{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}p,small,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:.8rem}summary{cursor:pointer;min-height:44px;display:list-item;align-content:center}h1{font-size:clamp(1.4rem,4vw,2rem)}:focus-visible{outline:3px solid Highlight;outline-offset:3px}
    </style></head><body><h1>Codex Web GPT diagnostic report</h1><p>${events.length} retained records · ${operations.length} operation records · ${failures.length} problems</p><p>Sanitized local evidence. Private captures and task titles are excluded. Missing records are not proof of success.</p>${notices.map(notice => `<p role="note">${escapeHtml(notice)}</p>`).join("")}${summary}<h2>Problems</h2>${failures.length ? failures.map(row).join("") : "<p>No problems in this selection.</p>"}<h2>Recorded activity</h2>${events.map(row).join("")}</body></html>`;
}

export async function exportDiagnostics(directory: string, input: ExportOptions, destination: string): Promise<{ records: number; incomplete: boolean }> {
  const options = ExportOptionsSchema.parse(input);
  const output = resolve(destination); const root = existsSync(directory) ? realpathSync(directory) : resolve(directory);
  if (containsPath(root, canonicalDestination(output))) throw new Error("Exports must not overwrite the diagnostics store or private captures");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || lstatSync(output).nlink > 1)) throw new Error("Export destination must not alias another file");
  const { events, ...metadata } = await assembleReport(directory, options.selection ?? { kind: "results", query: options.query });
  const { incomplete } = metadata;
  const html = renderReport(events, metadata.notices, metadata);
  const otlp = toOtlp(events);
  const outputData = options.format === "html" ? html : options.format === "json" ? JSON.stringify({ ...metadata, events }, null, 2)
    : options.format === "otlp" ? JSON.stringify(otlp, null, 2) : zipSync({
      "report.html": strToU8(html), "manifest.json": strToU8(JSON.stringify(metadata, null, 2)),
      "events.jsonl": strToU8(events.map(event => JSON.stringify(event)).join("\n")),
      "otlp-logs.json": strToU8(JSON.stringify(otlp.logs)), "otlp-traces.json": strToU8(JSON.stringify(otlp.traces)),
    });
  // The caller owns an explicitly chosen destination; do not change permissions on an existing parent.
  if (!existsSync(dirname(output))) privateDirectory(dirname(output));
  await writeExport(output, outputData);
  return { records: events.length, incomplete };
}
