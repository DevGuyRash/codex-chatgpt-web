import { DiagnosticStore } from "./store";
import { WorkerRequestSchema, type WorkerTerminationReason } from "./contracts";
import { queryDiagnostics } from "./query";
import { exportDiagnostics } from "./export";
import { copyReport } from "./report";
import { DiagnosticRequestError, diagnosticRequestCode, diagnosticRequestMessages, sqliteFailureDetails, type DiagnosticRequestCode } from "./request-error";
import { StringDecoder } from "node:string_decoder";

function readEnvelope(line: string) {
  const value: unknown = JSON.parse(line);
  const fields = value && typeof value === "object" ? value : {};
  return { value,
    id: "id" in fields && typeof fields.id === "string" && fields.id.length <= 96 ? fields.id : "invalid",
    method: "method" in fields && typeof fields.method === "string" ? fields.method : "invalid",
  };
}

/** Private stdio RPC. This worker never opens a network listener or runs bridge operations. */
export async function runDiagnosticsWorker(directory: string): Promise<void> {
  let store: DiagnosticStore;
  try { store = new DiagnosticStore(directory); }
  catch (error) {
    const failure = { event: "worker-startup-failed", code: diagnosticRequestCode(error, "unavailable"), details: { ...sqliteFailureDetails(error), phase: "startup" } };
    // Bootstrap has no request ID yet. Use the private transport without exposing
    // raw exceptions, paths or content through CLI stderr.
    await new Promise<void>(resolve => process.stdout.write(`${JSON.stringify(failure)}\n`, () => resolve()));
    process.stdin.destroy(); process.exitCode = 1;
    return;
  }
  const queries = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const importCancellation = new AbortController(); let importInFlight = false;
  let buffered = ""; let closing = false;
  let terminationReported = false;
  const reportTermination = (reason: WorkerTerminationReason) => {
    if (terminationReported) return;
    terminationReported = true;
    process.stdout.write(`${JSON.stringify({ event: "worker-stopping", reason })}\n`);
  };
  const decoder = new StringDecoder("utf8");
  const reply = (value: unknown) => {
    if (process.stdout.writableLength > 4 * 1024 * 1024) { reportTermination("output-backpressure"); closing = true; process.stdin.destroy(); return; }
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const maintenance = setInterval(() => { try { store.prune(); } catch { store.collectionFailure("Retention maintenance could not finish; check storage permissions and free space"); } }, 60_000);
  maintenance.unref();
  const handle = async (line: string) => {
    let id = "invalid";
    let method = "invalid";
    try {
      const envelope = readEnvelope(line);
      // Preserve correlation even when the method payload is invalid. The full schema
      // still owns execution authority; this only identifies the rejected request.
      id = envelope.id; method = envelope.method;
      const request = WorkerRequestSchema.parse(envelope.value); id = request.id; method = request.method;
      // Payload-free progress distinguishes worker execution from a request still waiting
      // in transport. This is not an acknowledgement of completion or permission to retry.
      reply({ event: "worker-request-started", id, method });
      let result: unknown;
      switch (request.method) {
        case "content-capture": result = store.contentCapture(request.command, phase => reply({ event: "worker-request-progress", id, method, phase })); break;
        case "append": result = { accepted: store.append(request.events, phase => reply({ event: "worker-request-progress", id, method, phase })) }; break;
        case "status": result = store.status(); break;
        case "query": {
          if (queries.size >= 4) throw new DiagnosticRequestError("busy");
          const controller = new AbortController(); queries.set(request.id, controller);
          try { result = await queryDiagnostics(directory, request.query, controller.signal); }
          finally { queries.delete(request.id); }
          break;
        }
        case "cancel": queries.get(request.requestId)?.abort(); result = {}; break;
        case "capture": result = store.capture(request.command); break;
        case "capture-status": result = store.captures(); break;
        case "capture-claim": result = { allowed: store.claimPrivateCapture(request.traceId) }; break;
        case "capture-write": result = store.writePrivateCapture(request.traceId, Buffer.from(request.png, "base64")); store.prune(); break;
        case "clear":
          if (request.scope === "normal" && importInFlight) throw new Error("Wait for historical import to finish before clearing normal diagnostics");
          result = store.clear(request.scope, request.confirmed); break;
        case "export": result = await exportDiagnostics(directory, request.options, request.destination); break;
        case "copy": result = await copyReport(directory, request.options); break;
        case "import": {
          if (importInFlight) throw new Error("A legacy import is already running");
          importInFlight = true;
          try { result = { imported: await store.importLegacy(request.files, "legacy", "production", importCancellation.signal) }; }
          finally { importInFlight = false; }
          break;
        }
        case "dropped": store.dropped(request.count); result = {}; break;
        case "close": reportTermination("request-close"); closing = true; process.stdin.pause(); result = {}; break;
      }
      reply({ id, ok: true, result });
    } catch (error) {
      // A cancelled/invalid search is not evidence loss. Only failed ingestion changes collection health.
      if (["append", "import", "dropped"].includes(method)) store.collectionFailure("A collection write failed; some evidence may be missing");
      const fallback: DiagnosticRequestCode = method === "query" ? "query_failed" : method === "export" ? "export_failed" : method === "capture" ? "capture_failed" : method === "clear" ? "clear_failed" : "unavailable";
      const code = diagnosticRequestCode(error, fallback);
      reply({ id, ok: false, code, error: diagnosticRequestMessages[code], details: sqliteFailureDetails(error) });
    }
  };
  const stopped = new Promise<void>(resolve => {
    const end = (reason: WorkerTerminationReason) => { reportTermination(reason); closing = true; resolve(); };
    process.stdin.on("data", chunk => {
      if (closing) return;
      buffered += decoder.write(Buffer.from(chunk));
      if (buffered.length > 2 * 1024 * 1024) { reply({ id: "invalid", ok: false, error: "Diagnostic message exceeded its size limit" }); process.stdin.pause(); end("input-too-large"); return; }
      let newline: number;
      while (!closing && (newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        if (pending.size >= 16) {
          let id = "invalid";
          try { id = readEnvelope(line).id; } catch { /* A malformed envelope cannot provide correlation. */ }
          reply({ id, ok: false, code: "busy", error: diagnosticRequestMessages.busy }); continue;
        }
        const task = handle(line); pending.add(task);
        void task.finally(() => { pending.delete(task); if (closing) resolve(); });
      }
    });
    process.stdin.once("end", () => end("input-ended")); process.stdin.once("error", () => end("input-error")); process.stdin.once("close", () => end("input-closed"));
    process.once("SIGTERM", () => end("SIGTERM")); process.once("SIGINT", () => end("SIGINT"));
  });
  await stopped;
  process.stdin.destroy();
  importCancellation.abort();
  for (const controller of queries.values()) controller.abort();
  await Promise.allSettled(pending); clearInterval(maintenance); store.close();
}
