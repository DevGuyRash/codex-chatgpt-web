import { Worker } from "node:worker_threads";
import { QuerySchema, QueryResultSchema, type DiagnosticQuery, type QueryResult } from "./contracts";
import { DiagnosticRequestError } from "./request-error";

/** A timed-out regex is terminated and joined, not merely abandoned behind a Promise.race. */
export async function queryDiagnostics(directory: string, input: DiagnosticQuery, signal?: AbortSignal): Promise<QueryResult> {
  const query = QuerySchema.parse(input);
  if (query.regex) { try { new RegExp(query.regex, "iu"); } catch { throw new DiagnosticRequestError("invalid_query"); } }
  signal?.throwIfAborted();
  const source = import.meta.url.endsWith(".ts");
  const worker = new Worker(new URL(source ? "./query-worker.ts" : "./diagnostics-query-worker.js", import.meta.url), { workerData: { directory, query } });
  return new Promise((resolve, reject) => {
    let finishing = false;
    const finish = async (error?: Error, result?: QueryResult) => {
      if (finishing) return; finishing = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      await worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => { void finish(signal?.reason instanceof Error ? signal.reason : new Error("Diagnostic query cancelled")); };
    const timer = setTimeout(() => { void finish(new DiagnosticRequestError("timeout")); }, 2000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", () => { void finish(new DiagnosticRequestError("query_failed")); });
    worker.once("exit", code => { if (!finishing) void finish(new Error(`Diagnostic query worker exited before returning results (${code})`)); });
    worker.once("message", message => {
      const parsed = QueryResultSchema.safeParse(message?.result);
      void finish(message?.ok && parsed.success ? undefined : new DiagnosticRequestError("query_failed"), parsed.success ? parsed.data : undefined);
    });
  });
}
