import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { DiagnosticStore } from "../src/diagnostics/store";
import { queryDiagnostics } from "../src/diagnostics/query";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";

// Closed-loop storage benchmark, not a claim about end-to-end Electron responsiveness.
// Run with the repository's pinned Bun. Synthetic content only; temporary stores are removed.
const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
console.log(JSON.stringify({ benchmark: "diagnostics-v1", runtime: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, querySamples: 30, loadModel: "closed-loop, batches of 128, one writer" }));
for (const [label, offered, limit] of [["default-budget", 30_000, 64 * 1024 * 1024], ["larger-dataset", 60_000, 256 * 1024 * 1024]] as const) {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-benchmark-"));
  let store: DiagnosticStore | undefined;
  try {
    store = new DiagnosticStore(root, { retention: { bytes: limit } });
    let accepted = 0; let ingestionMs = 0; let peakRss = process.memoryUsage().rss;
    const batchMs: number[] = [];
    for (let offset = 0; offset < offered; offset += 128) {
      const events: DiagnosticEvent[] = Array.from({ length: Math.min(128, offered - offset) }, (_, index) => ({ version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "log", name: "benchmark.stage", body: `${(offset + index) % 97 === 0 ? "needle" : "ordinary"} ${"structural synthetic stage ".repeat(28)}`, severity: index % 23 === 0 ? "error" : "info", component: "benchmark", environment: "test", target: `profile-${index % 4}`, taskId: `task-${offset + index}`, attributes: { sequence: offset + index } }));
      const start = performance.now(); accepted += store.append(events); const elapsed = performance.now() - start;
      ingestionMs += elapsed; batchMs.push(elapsed); peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    store.prune(); const status = store.status();
    const warmMs: number[] = [];
    for (let sample = 0; sample < 30; sample++) {
      const start = performance.now(); const result = store.query({ text: "needle", limit: 100 }); warmMs.push(performance.now() - start);
      if (!result.events.length || result.events.some(event => !event.body.includes("needle"))) throw new Error("Search returned incorrect evidence");
    }
    store.close(); store = undefined;
    const coldStart = performance.now();
    const cold = await queryDiagnostics(root, { text: "needle", limit: 100 }); const coldWorkerMs = performance.now() - coldStart;
    if (!cold.events.length) throw new Error("Cold query did not return evidence");
    console.log(JSON.stringify({ label, offered, accepted, retained: status.eventCount, retentionRemoved: accepted - status.eventCount, reportedDropped: status.dropped, notices: status.notices, limitBytes: limit, storedBytes: status.bytes,
      ingestionMs, recordsPerSecond: accepted / ingestionMs * 1000, batchP50Ms: percentile(batchMs, .5), batchP95Ms: percentile(batchMs, .95), warmQueryP50Ms: percentile(warmMs, .5), warmQueryP95Ms: percentile(warmMs, .95), coldWorkerMs, peakWriterRssBytes: peakRss }));
    if (accepted !== offered || status.bytes > limit) throw new Error("Storage acceptance/budget guardrail failed");
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
}
