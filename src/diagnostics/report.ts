import { DiagnosticStore } from "./store";
import { queryDiagnostics } from "./query";
import { sanitizeEvent } from "./privacy";
import { CopyOptionsSchema, ReportSelectionSchema, type CopyOptions, type DiagnosticEvent, type DiagnosticQuery, type ReportSelection } from "./contracts";

export const REPORT_EXCLUSIONS = "Private screenshots, task titles, credentials, and model content are excluded. Correlation IDs, component versions, and event timestamps remain; this report is not anonymous. Missing records are not proof of success.";

export function selectionQuery(input: ReportSelection): DiagnosticQuery {
  const selection = ReportSelectionSchema.parse(input);
  switch (selection.kind) {
    case "selection": return { eventIds: selection.eventIds, traceIds: selection.traceIds, ascending: true, snapshotSequence: selection.snapshotSequence };
    case "event": return { eventId: selection.eventId, snapshotSequence: selection.snapshotSequence };
    case "operation": return { traceId: selection.traceId, ascending: true, snapshotSequence: selection.snapshotSequence };
    case "all": return { snapshotSequence: selection.snapshotSequence };
    case "results": {
      // A loaded-page cursor is presentation state, not the selected result set.
      const { cursor: _cursor, follow: _follow, ...query } = selection.query;
      return { ...query, view: query.view === "groups" ? "overview" : query.view };
    }
  }
}

/** One bounded assembly path for ordinary reports. It never reads private capture files. */
export async function assembleReport(directory: string, selection: ReportSelection, limits = { records: 20_000, bytes: 32 * 1024 * 1024 }, campaignId?: string) {
  const query = selectionQuery(selection);
  const store = new DiagnosticStore(directory, { readonly: true });
  let collectionHealth;
  let collectionScope: ReturnType<DiagnosticStore["contentReportScope"]> = null;
  try {
    const status = store.status();
    query.snapshotSequence ??= status.lastSequence;
    collectionHealth = { ...status, targets: status.targets.map(() => "[target]"), captures: { ...status.captures, privateScope: status.captures.privateScope ? "[scope]" : "" } };
    if (campaignId && selection.kind === "selection" && !selection.eventIds?.length && selection.traceIds?.length) {
      collectionScope = store.contentReportScope(campaignId, selection.traceIds, query.snapshotSequence ?? 0);
    }
  } finally { store.close(); }
  const events: DiagnosticEvent[] = [], notices: string[] = [...collectionHealth.notices];
  let cursor: string | undefined, bytes = 0, incomplete = !collectionHealth.available || (collectionScope?.reportedDrops ?? collectionHealth.dropped) > 0, limited = false;
  if (collectionScope) notices.push(`Collection loss for the selected campaign is measured between its recorded ingestion boundaries (${collectionScope.reportedDrops} reported drops); the lifetime counter remains ${collectionHealth.dropped}. Unreported loss and task outcomes require separate evidence.`);
  do {
    const page = await queryDiagnostics(directory, { ...query, cursor, limit: 200 });
    for (const event of page.events) {
      const sanitized = sanitizeEvent(event, true), size = Buffer.byteLength(JSON.stringify(sanitized));
      if (events.length >= limits.records || bytes + size > limits.bytes) { limited = true; break; }
      bytes += size; events.push(sanitized);
    }
    notices.push(...page.notices); incomplete ||= page.incomplete; cursor = page.nextCursor;
  } while (cursor && !limited);
  if (limited) { incomplete = true; notices.push("Report reached its size limit; narrow the selection for additional records"); }
  if (events.some(event => ["capture.failed", "capture.campaign_failed"].includes(event.name))) {
    incomplete = true; notices.push("Collection failed during this selection; some capture evidence was not retained.");
  }
  if (!events.length && (selection.kind === "event" || selection.kind === "operation" || selection.kind === "selection")) {
    incomplete = true; notices.push("The selected evidence is no longer retained or is unavailable");
  }
  const versions = [...new Set(events.map(event => `${event.component}: ${event.attributes["service.version"] ?? "unknown"}`))];
  if (selection.kind === "selection") {
    const missing = (selection.eventIds ?? []).filter(id => !events.some(event => event.id === id)).length
      + (selection.traceIds ?? []).filter(id => !events.some(event => event.traceId === id)).length;
    if (missing) { incomplete = true; notices.push(`${missing} selected identities have no retained evidence in this snapshot`); }
  }
  const selectionDescription = selection.kind === "selection" ? `${selection.eventIds?.length ?? 0} events and ${selection.traceIds?.length ?? 0} operations`
    : selection.kind === "results" ? "Filtered results" : selection.kind;
  return { version: 1 as const, generatedAt: new Date().toISOString(), selection: { kind: selection.kind, description: selectionDescription, snapshotSequence: query.snapshotSequence }, records: events.length, incomplete, notices: [...new Set(notices)], privateCapturesIncluded: false as const, versions, collectionHealth, collectionScope, events };
}

export function readableReport(report: Awaited<ReturnType<typeof assembleReport>>): string {
  return [`Codex Web GPT diagnostics — ${report.records} records${report.incomplete ? " (incomplete evidence)" : ""}`,
    `Generated: ${report.generatedAt}\nSelection: ${report.selection.description}\nSnapshot sequence: ${report.selection.snapshotSequence ?? "unknown"}\nVersions: ${report.versions.join(", ") || "unknown"}`,
    `Collection: ${report.collectionHealth.available ? "available" : "unavailable"}\nLifetime reported dropped records: ${report.collectionHealth.dropped}\nRetained bytes: ${report.collectionHealth.bytes}`,
    REPORT_EXCLUSIONS, ...report.notices,
    ...report.events.map(event => [
      `${new Date(event.time).toISOString()} ${event.component} · ${event.name} · ${event.span?.outcome ?? event.severity}`, event.body,
      `Event: ${event.id}`, event.traceId ? `Operation: ${event.traceId} / Stage: ${event.spanId ?? "unavailable"} / Parent: ${event.parentSpanId ?? "root"}` : "Operation correlation unavailable",
      event.span ? `Started: ${new Date(event.span.startTime).toISOString()}\nEnded: ${event.span.endTime === undefined ? "No terminal evidence" : new Date(event.span.endTime).toISOString()}\nDuration: ${event.span.endTime === undefined ? "ongoing or unknown" : `${event.span.endTime - event.span.startTime} ms`}` : "",
      event.problem ? `Problem:\n${JSON.stringify(event.problem, null, 2)}` : "",
      Object.keys(event.attributes).length ? `Context:\n${JSON.stringify(event.attributes, null, 2)}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

export async function copyReport(directory: string, input: CopyOptions) {
  const options = CopyOptionsSchema.parse(input);
  const report = await assembleReport(directory, options.selection, { records: 1000, bytes: 256 * 1024 });
  const text = options.format === "json" ? JSON.stringify(report, null, 2) : readableReport(report);
  return { text, records: report.records, incomplete: report.incomplete, notices: report.notices };
}
