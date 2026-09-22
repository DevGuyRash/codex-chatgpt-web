import { lstatSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { Zip, ZipDeflate, strToU8 } from "fflate";
import { ExportOptionsSchema, reportedCaptureDrops, type DiagnosticEvent, type DiagnosticStatus, type ExportOptions } from "./contracts";
import { privateDirectory, DiagnosticStore } from "./store";
import { assembleReport, readableReport } from "./report";
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

/** Compress one bounded entry at a time and let the destination apply backpressure. */
async function* zipEntries(entries: Iterable<[string, Uint8Array]>) {
  let chunks: Uint8Array[] = [], failure: Error | null = null;
  const zip = new Zip((error, chunk) => { if (error) failure = error; else chunks.push(chunk); });
  try {
    for (const [name, bytes] of entries) {
      const file = new ZipDeflate(name);
      zip.add(file); file.push(bytes, true);
      if (failure) throw failure;
      for (const chunk of chunks) yield chunk;
      chunks = [];
    }
    zip.end();
    if (failure) throw failure;
    for (const chunk of chunks) yield chunk;
  } finally { zip.terminate(); }
}

export async function exportDiagnostics(directory: string, input: ExportOptions, destination: string): Promise<{ records: number; incomplete: boolean; files: number }> {
  const options = ExportOptionsSchema.parse(input);
  const output = resolve(destination); const root = existsSync(directory) ? realpathSync(directory) : resolve(directory);
  if (containsPath(root, canonicalDestination(output))) throw new Error("Exports must not overwrite the diagnostics store or private captures");
  if (existsSync(output) && (lstatSync(output).isSymbolicLink() || lstatSync(output).nlink > 1)) throw new Error("Export destination must not alias another file");
  const report = await assembleReport(directory, options.selection ?? { kind: "results", query: options.query }, undefined, options.content?.campaignId);
  const { events } = report;
  let scopedContent: { campaignId: string; scope: string; attachments: number; bytes: number; omitted: number } | undefined;
  let contentManifest: ReturnType<DiagnosticStore["contentManifest"]> | undefined;
  if (options.content) {
    if (options.format !== "bundle") throw new Error("Content-inclusive evidence requires a support bundle");
    const store = new DiagnosticStore(directory, { readonly: true });
    try {
      const manifest = contentManifest = store.contentManifest(options.content.campaignId);
      scopedContent = { campaignId: manifest.campaignId, scope: "Entire explicitly selected campaign at export start, independently of the diagnostic record selection", attachments: manifest.attachments.length, bytes: manifest.attachments.reduce((total, item) => total + item.bytes, 0), omitted: manifest.omitted };
      report.notices.push(`Content attachments cover the entire selected campaign at export start (${manifest.attachments.length} attachments); diagnostic records use the report selection.`);
      const captureDrops = reportedCaptureDrops(manifest.collectionWindow);
      if (captureDrops === null) { report.incomplete = true; report.notices.push("The selected campaign has no valid recorded collection-loss boundary; historical collection loss cannot be assigned to this scope."); }
      else if (captureDrops > 0) { report.incomplete = true; report.notices.push(`${captureDrops} collection drops were reported during the selected campaign; their attribution within that interval is unknown.`); }
      if (!manifest.finished) { report.incomplete = true; report.notices.push("The selected campaign is still open; this export is a snapshot, not final campaign evidence."); }
      if (manifest.omitted) { report.incomplete = true; report.notices.push(`${manifest.omitted} campaign content captures were omitted; see the content manifest.`); }
      if (manifest.collectionFailures) { report.incomplete = true; report.notices.push(`${manifest.collectionFailures} campaign collection failures were recorded; omission counts may overlap or be incomplete.`); }
      const unfinished = manifest.documents.filter(document => document.status !== "stored").length;
      if (unfinished) { report.incomplete = true; report.notices.push(`${unfinished} campaign documents were not completely retained; see the content manifest.`); }
    } finally { store.close(); }
  }
  const { events: _events, ...baseMetadata } = report;
  const metadata = { ...baseMetadata, scopedContentIncluded: Boolean(scopedContent), scopedContent };
  const { incomplete } = metadata;
  const html = renderReport(events, metadata.notices, metadata);
  const otlp = toOtlp(events);
  function* entries(): Generator<[string, Uint8Array]> {
    yield* Object.entries({
      "report.html": strToU8(html), "manifest.json": strToU8(JSON.stringify(metadata, null, 2)),
      "events.jsonl": strToU8(events.map(event => JSON.stringify(event)).join("\n")),
      "otlp-logs.json": strToU8(JSON.stringify(otlp.logs)), "otlp-traces.json": strToU8(JSON.stringify(otlp.traces)),
      "summary.txt": strToU8(readableReport(report)),
    });
    if (contentManifest && options.content) {
      const store = new DiagnosticStore(directory, { readonly: true });
      try {
        const exportedAttachments = [];
        const documents = new Map(contentManifest.documents.map(document => [document.id, { ...document, hash: createHash("sha256"), observedBytes: 0, observedChunks: 0 }]));
        // Document chunks are exported in their declared order; attachment hashes still pin the snapshot.
        const ordered = [...contentManifest.attachments].sort((a, b) => (a.document?.id ?? a.id).localeCompare(b.document?.id ?? b.id) || (a.document?.index ?? 0) - (b.document?.index ?? 0));
        for (const attachment of ordered) {
          const row = store.contentAttachment(contentManifest.campaignId, attachment, options.content.acknowledged);
          const screenshot = attachment.category === "screenshot";
          const file = `content/${row.id}.${screenshot ? "png" : "txt"}`;
          const bytes = screenshot ? Buffer.from(row.text, "base64") : strToU8(row.text);
          if (attachment.document) {
            const document = documents.get(attachment.document.id);
            if (!document || document.status !== "stored" || document.traceId !== attachment.traceId || document.category !== attachment.category || attachment.document.index !== document.observedChunks) throw new Error("Captured document chunk sequence failed its integrity check");
            document.hash.update(bytes); document.observedBytes += bytes.byteLength; document.observedChunks++;
          }
          exportedAttachments.push({ ...attachment, storageEncoding: screenshot ? "base64" : "utf8", file, fileBytes: bytes.byteLength, fileSha256: createHash("sha256").update(bytes).digest("hex") });
          yield [file, bytes];
        }
        for (const document of documents.values()) if (document.status === "stored" && (document.observedChunks !== document.chunks || document.observedBytes !== document.bytes || document.hash.digest("hex") !== document.sha256)) throw new Error("Captured document failed its complete-content integrity check");
        yield ["content/manifest.json", strToU8(JSON.stringify({ ...contentManifest, attachments: exportedAttachments }, null, 2))];
      } finally { store.close(); }
    }
  }
  const outputData = options.format === "html" ? html : options.format === "json" ? JSON.stringify({ ...metadata, events }, null, 2)
    : options.format === "otlp" ? JSON.stringify(otlp, null, 2) : zipEntries(entries());
  // The caller owns an explicitly chosen destination; do not change permissions on an existing parent.
  if (!existsSync(dirname(output))) privateDirectory(dirname(output));
  await writeExport(output, outputData);
  return { records: events.length, incomplete, files: options.format === "bundle" ? 6 + (contentManifest ? 1 + contentManifest.attachments.length : 0) : 1 };
}
