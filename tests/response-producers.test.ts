import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest, compactRequest, HttpTurnCounter, startServer } from "../src/server";
import { ResponseProducers } from "../src/response-producers";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { readGoldenEvents } from "../scripts/golden/observations";
import { deferred, responseCaptureFixture } from "./response-capture-fixture";
import type { ProviderAdapter } from "../src/adapters/base";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiagnosticStore } from "../src/diagnostics/store";

function request(stream = true) {
  return new Request("http://localhost/v1/responses", { method: "POST", body: JSON.stringify({ model: "chatgpt-web/light", stream, input: "Synthetic settlement fixture" }) });
}

const connectorFailure = () => new ChatGptWebAdapterError("Synthetic connector unavailable", {
  status: 502, errorType: "server_error", code: "connector_not_found", retryable: false,
});

for (const protocol of ["native", "compatibility-v1"] as const) {
  for (const outcome of ["success", "error", "cancellation"] as const) test(`${protocol}: ${outcome} HTTP terminal precedes capture but owner acceptance cannot`, async () => {
    const f = responseCaptureFixture(), owner = new ResponseProducers(), turns = new HttpTurnCounter();
    const started = deferred();
    const factory = (): ProviderAdapter => ({ name: "synthetic-owner", async runTurn(_parsed, incoming, emit) {
      started.resolve();
      if (outcome === "cancellation") {
        await new Promise<void>((_resolve, reject) => {
          if (incoming.abortSignal?.aborted) reject(incoming.abortSignal.reason);
          else incoming.abortSignal?.addEventListener("abort", () => reject(incoming.abortSignal!.reason), { once: true });
        });
      }
      if (outcome === "error") throw connectorFailure();
      emit({ type: "text_delta", text: "synthetic" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } });
    let settled = false, inspected = false;
    try {
      const response = await owner.run(() => turns.track(() => responseRequest(request(), { ...defaultConfig("browser-only"), subagentProtocol: protocol }, factory, { producers: owner, rememberState: false })));
      const text = response.text();
      await started.promise;
      if (outcome === "cancellation") owner.stop();
      await f.waiting.promise;
      const body = await text;
      expect(body.match(/event: response\.(completed|failed)\n/g)).toHaveLength(1);
      expect(body).toContain(outcome === "success" ? "response.completed" : "response.failed");
      if (outcome === "error") expect(body).toContain("connector_not_found");
      expect(turns.count()).toBe(0);
      expect(f.events.filter(event => event.name === "adapter.turn" && event.span?.endTime)).toHaveLength(0);
      // This deliberately inspects a held fixture to prove the existing guard remains strict.
      await expect(readGoldenEvents(f.client, f.campaignId)).rejects.toThrow("incomplete evidence");
      owner.stop();
      const finished = owner.settle(1000).then(async () => {
        settled = true; inspected = true; return readGoldenEvents(f.client, f.campaignId);
      });
      await Promise.resolve();
      expect(settled).toBe(false); expect(inspected).toBe(false); expect(owner.settled).toBe(false);
      expect(f.acknowledgements()).toBe(0);
      f.release.resolve(); await finished;
      expect(owner.settled).toBe(true); expect(inspected).toBe(true);
      expect(f.writes()).toBe(1); expect(f.acknowledgements()).toBe(1);
      const terminals = f.events.filter(event => event.name === "adapter.turn" && event.span?.endTime);
      expect(terminals).toHaveLength(1);
      // SSE terminal consumption already invokes its cancellation callback. Preserve that
      // existing outcome and the independently recorded completion.observed value.
      expect(terminals[0]!.span!.outcome).toBe(outcome === "error" ? "failed" : "cancelled");
      expect(terminals[0]!.attributes["completion.observed"]).toBe(outcome === "success");
    } finally { f.release.resolve(); owner.stop(); await owner.settle(1000).catch(() => {}); await f.close(); }
  });
}

test("capture failure settles once but remains rejected by golden evidence", async () => {
  const f = responseCaptureFixture({ fail: true }), owner = new ResponseProducers();
  try {
    const response = await responseRequest(request(), defaultConfig("browser-only"), () => ({ name: "synthetic-error", async runTurn() { throw connectorFailure(); } }), { producers: owner, rememberState: false });
    const text = response.text(); await f.waiting.promise; await text;
    owner.stop(); const done = owner.settle(1000); f.release.resolve(); await done;
    expect(f.writes()).toBe(1); expect(f.acknowledgements()).toBe(0);
    expect(f.events.filter(event => event.name === "capture.campaign_failed")).toHaveLength(1);
    expect(f.events.filter(event => event.name === "adapter.turn" && event.span?.endTime)).toHaveLength(1);
    await expect(readGoldenEvents(f.client, f.campaignId)).rejects.toThrow("content capture failed");
  } finally { f.release.resolve(); owner.stop(); await owner.settle(1000).catch(() => {}); await f.close(); }
});

test("a held prompt acknowledgement cannot launch adapter work after admission is sealed", async () => {
  const f = responseCaptureFixture({ category: "prompt" }), owner = new ResponseProducers();
  let runs = 0;
  try {
    const response = await responseRequest(request(), defaultConfig("browser-only"), () => ({ name: "late-adapter", async runTurn() { runs++; } }), { producers: owner, rememberState: false });
    const text = response.text(); await f.waiting.promise;
    owner.stop(); const done = owner.settle(1000);
    expect(runs).toBe(0); f.release.resolve(); await done;
    expect(await text).toContain("client_cancelled"); expect(runs).toBe(0);
  } finally { f.release.resolve(); owner.stop(); await owner.settle(1000).catch(() => {}); await f.close(); }
});

for (const compact of [false, true]) test(`late ${compact ? "compact" : "response"} body cannot start a producer after teardown`, async () => {
  const owner = new ResponseProducers(), reading = deferred();
  let source!: ReadableStreamDefaultController<Uint8Array>, runs = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, pull() { reading.resolve(); } });
  const req = new Request("http://localhost/v1/responses", { method: "POST", body, duplex: "half" } as RequestInit);
  const handler = compact ? compactRequest : responseRequest;
  const result = handler(req, defaultConfig("browser-only"), () => ({ name: "late-parser", async runTurn() { runs++; } }), { producers: owner }).catch(error => error);
  await reading.promise; await Promise.resolve();
  owner.stop(); let settled = false;
  const done = owner.settle(1000).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  source.enqueue(new TextEncoder().encode(JSON.stringify({ model: "chatgpt-web/high", stream: true, input: "Late body" }))); source.close();
  expect(await result).toBe(owner.signal.reason); await done;
  expect(runs).toBe(0); expect(owner.settled).toBe(true);
  expect(() => owner.run(async () => { runs++; })).toThrow("owner is stopping");
});

test("producer rejection is retained without failing fast ahead of another producer", async () => {
  const owner = new ResponseProducers(), held = deferred(), started = deferred();
  const failure = new Error("Synthetic producer failure");
  const rejected = owner.run(async () => { throw failure; }).catch(error => error);
  owner.run(async () => { started.resolve(); await held.promise; });
  expect(await rejected).toBe(failure); await started.promise; owner.stop();
  let completed = false;
  const done = owner.settle(1000).catch(error => { completed = true; return error; });
  await Promise.resolve(); expect(completed).toBe(false);
  held.resolve(); const error = await done;
  expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([failure]);
});

test("a timed-out owner remains uncertain after late completion and caller budget can shorten its bound", async () => {
  for (const useCallerBudget of [false, true]) {
    const owner = new ResponseProducers(), held = deferred(), started = deferred();
    owner.run(async () => { started.resolve(); await held.promise; }); await started.promise; owner.stop();
    const done = owner.settle(useCallerBudget ? 0 : 1);
    await expect(done).rejects.toThrow(useCallerBudget ? "stopping boundary" : "cleanup deadline");
    expect(owner.settled).toBe(false); held.resolve(); await Promise.resolve(); await Promise.resolve();
    await expect(owner.settle(1000)).rejects.toThrow(useCallerBudget ? "stopping boundary" : "cleanup deadline");
  }
});

test("producer settlement does not accept truncated diagnostics or an unrelated open span", async () => {
  const f = responseCaptureFixture(), owner = new ResponseProducers();
  try {
    const response = await responseRequest(request(), defaultConfig("browser-only"), () => ({ name: "synthetic-error", async runTurn() { throw connectorFailure(); } }), { producers: owner, rememberState: false });
    const text = response.text(); await f.waiting.promise; await text; owner.stop();
    const done = owner.settle(1000); f.release.resolve(); await done;
    const normal = await readGoldenEvents(f.client, f.campaignId);
    await expect(readGoldenEvents({ ...f.client, query: async query => ({ ...await f.client.query(query), incomplete: true, notices: ["Synthetic truncation"] }) }, f.campaignId)).rejects.toThrow("incomplete evidence");
    const source = normal.events.find(event => event.name === "adapter.turn" && event.span?.outcome === "running")!;
    f.store.append([{ ...source, id: crypto.randomUUID(), spanId: "f".repeat(16), name: "fixture.unrelated_open" }]);
    await expect(readGoldenEvents(f.client, f.campaignId)).rejects.toThrow("incomplete evidence");
  } finally { f.release.resolve(); owner.stop(); await owner.settle(1000).catch(() => {}); await f.close(); }
});

test("unresolved cleanup retires real diagnostics workers and lets the operator exit without synthetic terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-owner-exit-"));
  const directory = join(root, "diagnostics", "observability"), workerPid = join(root, "worker.pid");
  const worker = `import {appendFileSync} from 'node:fs'; import {runDiagnosticsWorker} from ${JSON.stringify(resolve("src/diagnostics/worker.ts"))}; appendFileSync(${JSON.stringify(workerPid)},String(process.pid)+'\\n'); await runDiagnosticsWorker(${JSON.stringify(directory)});`;
  const script = `
    import { DiagnosticsClient } from ${JSON.stringify(resolve("src/diagnostics/client.ts"))};
    import { initializeRuntimeDiagnostics, runtimeCaptureClient } from ${JSON.stringify(resolve("src/diagnostics/runtime.ts"))};
    import { ResponseProducers } from ${JSON.stringify(resolve("src/response-producers.ts"))};
    import { closeUnsettledGoldenDiagnostics } from ${JSON.stringify(resolve("scripts/golden/live-batch.ts"))};
    const invocation = { executable: process.execPath, args: ['-e', ${JSON.stringify(worker)}] };
    process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify(invocation);
    const sink = new DiagnosticsClient(invocation);
    const diagnostics = initializeRuntimeDiagnostics({component:'golden',sink});
    await sink.status(); await runtimeCaptureClient().status();
    const owner = new ResponseProducers();
    owner.run(async () => { diagnostics.begin('adapter.turn', {}, null); await new Promise(() => {}); });
    await Promise.resolve(); owner.stop();
    try { await owner.settle(0); throw new Error('Timeout was not retained'); }
    catch (error) { if (!String(error).includes('stopping boundary')) throw error; }
    await closeUnsettledGoldenDiagnostics(sink);
    if (owner.settled) throw new Error('Unresolved producer was concealed');
    console.log('closed-unresolved');
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race([child.exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Unsettled owner kept the operator alive")); }, 10_000);
    })]);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exited, stderr).toBe(0); expect(stdout).toContain("closed-unresolved");
    const workerPids = readFileSync(workerPid, "utf8").trim().split("\n").map(Number);
    expect(new Set(workerPids).size).toBe(2);
    for (const pid of workerPids) expect(() => process.kill(pid, 0)).toThrow();
    const store = new DiagnosticStore(directory, { readonly: true });
    try {
      const evidence = store.query({ view: "events", limit: 200 });
      expect(evidence.incomplete).toBe(true);
      expect(evidence.events.filter(event => event.name === "adapter.turn" && event.span?.endTime)).toHaveLength(0);
      expect(evidence.events.filter(event => event.name === "adapter.turn" && event.span?.outcome === "running")).toHaveLength(1);
    } finally { store.close(); }
  } finally { clearTimeout(timer); child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
}, 15_000);

test("an owned server cannot run standalone signal or administrative shutdown ahead of its producer join", async () => {
  const owner = new ResponseProducers(), config = { ...defaultConfig("browser-only"), port: 0 };
  const sigint = process.listenerCount("SIGINT"), sigterm = process.listenerCount("SIGTERM");
  const server = startServer(config, { responseProducers: owner });
  try {
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/shutdown`, { method: "POST", headers: { authorization: `Bearer ${config.controlToken}` } });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("Runtime owner must settle");
    expect(owner.signal.aborted).toBe(false);
  } finally { owner.stop(); await server.stop(true); await owner.settle(1000); }
});
