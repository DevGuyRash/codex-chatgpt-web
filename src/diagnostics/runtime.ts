import { createWriteStream, fstatSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { VERSION } from "../version";
import { DiagnosticsClient, type WorkerInvocation } from "./client";
import { Diagnostics, parseTraceparent, type DiagnosticSink, type DiagnosticContext } from "./instrumentation";
import { WorkerInvocationSchema, type DiagnosticEvent } from "./contracts";

let diagnostics: Diagnostics | undefined;
let client: DiagnosticsClient | undefined;
let closeSink: (() => Promise<void>) | undefined;
let controlInvocation: WorkerInvocation | undefined;
export function runtimeCaptureClient(): DiagnosticsClient | undefined {
  if (client) return client;
  if (!controlInvocation) return;
  client = new DiagnosticsClient(controlInvocation);
  return client;
}
export function runtimeDiagnostics(): Diagnostics | undefined { return diagnostics; }
export function setRuntimeDiagnostics(value: Diagnostics | undefined): void { diagnostics = value; }

export function initializeRuntimeDiagnostics(options: { component: string; target?: string; standalone?: boolean; sink?: DiagnosticSink }): Diagnostics | undefined {
  if (diagnostics) return diagnostics;
  if (process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER) {
    try { controlInvocation = WorkerInvocationSchema.parse(JSON.parse(process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER)); } catch { controlInvocation = undefined; }
  }
  let sink = options.sink;
  if (!sink && process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_FD === "3") {
    try {
      const stat = fstatSync(3);
      if (!stat.isFIFO() && !stat.isSocket()) return;
      const stream = createWriteStream("", { fd: 3, autoClose: false });
      let failed = false; let dropped = 0;
      stream.on("error", () => { failed = true; });
      sink = {
        emit(event) {
          if (failed || stream.writableLength > 4 * 1024 * 1024) { dropped++; return; }
          const line = `${JSON.stringify(event)}\n`;
          if (Buffer.byteLength(line) > 64 * 1024) { dropped++; return; }
          stream.write(line);
        },
        flush: () => new Promise<void>(resolve => {
          if (failed || stream.destroyed) { resolve(); return; }
          const timer = setTimeout(resolve, 1000);
          stream.write("", () => { clearTimeout(timer); resolve(); });
        }),
      };
      closeSink = async () => { await sink?.flush?.(); stream.end(); };
    } catch { return; }
  }
  if (!sink && options.standalone && typeof Bun !== "undefined") {
    controlInvocation = { executable: process.execPath, args: [process.argv[1], "--home", getConfigDir(), "diagnostics", "worker"] };
    process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify(controlInvocation);
    client = new DiagnosticsClient(controlInvocation);
    sink = client;
  }
  if (!sink) return;
  // Observe shared controls without putting a database round trip on each browser checkpoint.
  if (!client && controlInvocation) runtimeCaptureClient();
  diagnostics = new Diagnostics(sink, { component: options.component, target: options.target ?? "base", environment: process.env.CODEX_WEB_GPT_DEV_PROFILE === "1" ? "development" : "production", version: VERSION,
    debugEnabled: () => client?.debugEnabled() ?? false });
  return diagnostics;
}
export function runtimeParent(): DiagnosticContext | undefined { return parseTraceparent(process.env.CODEX_CHATGPT_WEB_TRACEPARENT); }
export async function closeRuntimeDiagnostics(): Promise<void> {
  const current = diagnostics; diagnostics = undefined;
  await current?.close(); await closeSink?.(); await client?.close(); client = undefined; closeSink = undefined; controlInvocation = undefined;
}
