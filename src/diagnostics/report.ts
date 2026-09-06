import { DiagnosticStore } from "./store";
import { queryDiagnostics } from "./query";
import { sanitizeEvent } from "./privacy";
import { CopyOptionsSchema, ReportSelectionSchema, type CopyOptions, type DiagnosticEvent, type DiagnosticQuery, type ReportSelection } from "./contracts";

export const REPORT_EXCLUSIONS = "Private screenshots, task titles, credentials, and model content are excluded. Correlation IDs, component versions, and event timestamps remain; this report is not anonymous. Missing records are not proof of success.";

export function selectionQuery(input: ReportSelection): DiagnosticQuery {
  const selection = ReportSelectionSchema.parse(input);
  switch (selection.kind) {
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
export async function assembleReport(directory: string, selection: ReportSelection, limits = { records: 20_000, bytes: 32 * 1024 * 1024 }) {
  const query = selectionQuery(selection);
  const store = new DiagnosticStore(directory, { readonly: true });
  let collectionHealth;
  try {
    const status = store.status();
    query.snapshotSequence ??= status.lastSequence;
    collectionHealth = { ...status, targets: status.targets.map(() => "[target]"), captures: { ...status.captures, privateScope: status.captures.privateScope ? "[scope]" : "" } };
  } finally { store.close(); }
  const events: DiagnosticEvent[] = [], notices: string[] = [...collectionHealth.notices];
  let cursor: string | undefined, bytes = 0, incomplete = !collectionHealth.available || collectionHealth.dropped > 0, limited = false;
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
  if (!events.length && (selection.kind === "event" || selection.kind === "operation")) {
    incomplete = true; notices.push("The selected evidence is no longer retained or is unavailable");
  }
  const versions = [...new Set(events.map(event => `${event.component}: ${event.attributes["service.version"] ?? "unknown"}`))];
  return { version: 1 as const, generatedAt: new Date().toISOString(), records: events.length, incomplete, notices: [...new Set(notices)], privateCapturesIncluded: false as const, versions, collectionHealth, events };
}

export function readableReport(report: Awaited<ReturnType<typeof assembleReport>>): string {
  return [`Codex Web GPT diagnostics — ${report.records} records${report.incomplete ? " (incomplete evidence)" : ""}`, REPORT_EXCLUSIONS, ...report.notices,
    ...report.events.map(event => `${new Date(event.time).toISOString()} ${event.component} · ${event.name} · ${event.span?.outcome ?? event.severity}\n${event.body}${event.problem ? `\n${event.problem.code}: ${event.problem.message}\nRecovery: ${event.problem.recovery}` : ""}${event.traceId ? `\nOperation: ${event.traceId}` : ""}`),
  ].join("\n\n");
}

export async function copyReport(directory: string, input: CopyOptions) {
  const options = CopyOptionsSchema.parse(input);
  const report = await assembleReport(directory, options.selection, { records: 1000, bytes: 256 * 1024 });
  const text = options.format === "json" ? JSON.stringify(report, null, 2) : readableReport(report);
  return { text, records: report.records, incomplete: report.incomplete, notices: report.notices };
}
