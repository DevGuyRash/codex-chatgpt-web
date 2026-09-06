import { join } from "node:path";
import { once } from "node:events";
import { getConfigDir } from "../config";
import { DiagnosticStore } from "./store";
import { QuerySchema, unavailableStatus, type DiagnosticQuery, type DiagnosticStatus } from "./contracts";
import { queryDiagnostics } from "./query";
import { exportDiagnostics } from "./export";
import { runDiagnosticsWorker } from "./worker";

const HELP = `Diagnostics (local, read-only unless explicitly exporting):
  diagnostics status [--json]
  diagnostics list [--view operations|events|problems] [--limit N] [--json]
  diagnostics show TRACE_ID [--json]
  diagnostics search TEXT [--regex PATTERN] [--json]
  diagnostics follow [--trace TRACE_ID] [--json]
  diagnostics export --output PATH [--format bundle|html|json|otlp]
Filters: --target ID --component NAME --severity debug|info|warning|error
         --task ID --from ISO_DATE --to ISO_DATE --cursor CURSOR
Target selection uses the existing --home / --codex-home / --codex-profile options.
`;
function option(args: string[], name: string): string | undefined { const index = args.indexOf(name); if (index < 0) return; const value = args[index + 1]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`); args.splice(index, 2); return value; }
function flag(args: string[], name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }

export async function runDiagnosticsCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  const directory = join(getConfigDir(), "diagnostics", "observability");
  if (action === "worker") { if (args.length) throw new Error("Unexpected diagnostics worker argument"); await runDiagnosticsWorker(directory); return; }
  if (action === "help") { process.stdout.write(HELP); return; }
  const json = flag(args, "--json");
  const format = option(args, "--format") ?? "bundle"; const output = option(args, "--output");
  const view = option(args, "--view") ?? (action === "list" ? "operations" : "events");
  const limit = Number(option(args, "--limit") ?? "100");
  const from = option(args, "--from"); const to = option(args, "--to");
  const query: DiagnosticQuery = QuerySchema.parse({ view, limit, traceId: option(args, "--trace"), taskId: option(args, "--task"),
    target: option(args, "--target"), component: option(args, "--component"), severity: option(args, "--severity"), cursor: option(args, "--cursor"),
    regex: option(args, "--regex"), from: from ? Date.parse(from) : undefined, to: to ? Date.parse(to) : undefined });
  if (action === "show") {
    const trace = args.shift();
    if (!trace) throw new Error("diagnostics show requires TRACE_ID");
    query.traceId = trace;
  }
  if (action === "search" && args.length && !args[0].startsWith("--")) query.text = args.shift();
  if (args.length) throw new Error(`Unexpected diagnostics argument; see diagnostics help`);
  QuerySchema.parse(query);
  if (action === "status") {
    let store: DiagnosticStore | undefined;
    let status: DiagnosticStatus;
    try {
      store = new DiagnosticStore(directory, { readonly: true });
      status = store.status();
    } catch {
      status = unavailableStatus("Diagnostics storage is unavailable; retained records may still exist. Check disk space, permissions, and component versions");
    } finally { store?.close(); }
    process.stdout.write(json ? `${JSON.stringify(status, null, 2)}\n` : `${status.available ? "Diagnostics available" : status.notices.length ? "Diagnostics unavailable" : "No diagnostics recorded"}\n${status.eventCount} events · ${status.operationCount} operations · ${status.problemCount} problems\n${status.bytes} bytes stored · ${status.dropped} records dropped\n${status.notices.join("\n")}\n`);
    return;
  }
  if (action === "export") {
    if (!output || !["bundle", "html", "json", "otlp"].includes(format)) throw new Error("Export requires --output PATH and a supported --format");
    const result = await exportDiagnostics(directory, { format: format as "bundle" | "html" | "json" | "otlp", query }, output);
    process.stdout.write(`${JSON.stringify({ ...result, path: output })}\n`); return;
  }
  if (!["list", "show", "search", "follow"].includes(action)) throw new Error(HELP);
  let stopped = false;
  const abort = new AbortController();
  const write = async (text: string) => {
    abort.signal.throwIfAborted();
    if (!process.stdout.write(text)) await once(process.stdout, "drain", { signal: abort.signal });
  };
  const stop = () => { stopped = true; abort.abort(); };
  if (action === "follow") { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  let cursor = query.cursor;
  try {
    do {
      const result = await queryDiagnostics(directory, { ...query, ...(action === "follow" ? { ascending: true, follow: true, cursor } : {}) }, abort.signal);
      const fresh = result.events;
      if (json) await write(`${JSON.stringify({ ...result, events: fresh })}\n`);
      else {
        for (const event of fresh) await write(`${new Date(event.time).toISOString()}  ${event.span?.outcome ?? event.severity}  ${event.name}\n  ${event.body}\n  ${event.traceId ? `trace ${event.traceId}` : "uncorrelated"} · ${event.component}\n`);
        for (const notice of result.notices) await write(`Notice: ${notice}\n`);
        if (result.nextCursor) await write(`Next cursor: ${result.nextCursor}\n`);
      }
      if (action !== "follow") break;
      cursor = result.nextCursor ?? result.followCursor ?? cursor;
      if (result.nextCursor) continue;
      if (result.incomplete && !result.followCursor) throw new Error("Follow search could not complete within its work limit; narrow the query");
      await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); abort.signal.removeEventListener("abort", done); resolve(); } abort.signal.addEventListener("abort", done, { once: true }); });
    } while (!stopped);
  } catch (error) { if (!stopped) throw error; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
