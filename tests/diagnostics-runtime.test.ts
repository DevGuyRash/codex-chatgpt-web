import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Diagnostics, parseTraceparent, traceparent } from "../src/diagnostics/instrumentation";
import { DiagnosticError, runtimeFailure } from "../src/diagnostics/problems";
import { DiagnosticStore } from "../src/diagnostics/store";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { queryDiagnostics } from "../src/diagnostics/query";
import { exportDiagnostics, toOtlp } from "../src/diagnostics/export";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { setRuntimeDiagnostics } from "../src/diagnostics/runtime";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "diagnostics-runtime-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
test("CLI show requires a trace instead of returning unrelated records", async () => {
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", root(), "diagnostics", "show", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("show requires TRACE_ID");
});
test("CLI status reports unavailable collection as versioned JSON without disclosing corrupt content", async () => {
  const home = root(); const directory = join(home, "diagnostics", "observability"); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "diagnostics.sqlite"), "private corrupt database content");
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", home, "diagnostics", "status", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  const status = JSON.parse(stdout); expect(status.version).toBe(1); expect(status.available).toBe(false);
  expect(status.notices.join(" ")).toContain("unavailable");
  expect(stdout + stderr).not.toContain("private corrupt");
});
test("OpenTelemetry traces correlate nested stages and safe structured problems", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "test", environment: "test", target: "base", version: "5.0.3" });
  const operation = diagnostics.begin("Upgrade runtime", {}, undefined, { id: "task-1", name: "Supplied task name" });
  await operation.run(() => diagnostics.run("Preflight", async child => {
    diagnostics.event("preview.validated", "Preview checked");
    const problem = child.problem(new DiagnosticError({ code: "setup_preview_stale", message: "Preview changed" }));
    expect(problem.traceId).toBe(operation.context.traceId);
  }));
  operation.end("failed"); await diagnostics.close();
  expect(events.every(event => event.traceId === operation.context.traceId)).toBe(true);
  expect(events.find(event => event.name === "Preflight" && event.span?.endTime)?.parentSpanId).toBe(operation.context.spanId);
  expect(events.find(event => event.kind === "problem")?.problem?.actions).toContain("review-setup");
  expect(events.filter(event => event.span?.endTime).every(event => event.taskName === "Supplied task name")).toBe(true);
  expect(parseTraceparent(traceparent(operation.context))).toEqual({ traceId: operation.context.traceId, spanId: operation.context.spanId });
  expect(parseTraceparent(`00-${"0".repeat(32)}-${"0".repeat(16)}-01`)).toBeUndefined();
  const otlp = toOtlp(events); expect(otlp.traces.resourceSpans[0].scopeSpans[0].spans.length).toBe(2);
  expect(otlp.traces.resourceSpans[0].resource.attributes).toContainEqual({ key: "service.version", value: { stringValue: "5.0.3" } });
});
test("structured errors retain their cause; unsupported child actions cannot execute", () => {
  const error = new DiagnosticError({ code: "setup_preview_stale", message: "Review a fresh preview", recovery: "not-needed" });
  const decoded = runtimeFailure(`CGW_ERROR_V2 ${JSON.stringify(error.problem)}`, "Failed");
  expect(decoded.problem.code).toBe("setup_preview_stale"); expect(decoded.problem.recovery).toBe("not-needed");
  expect(runtimeFailure('CGW_ERROR_V2 {"code":"x","actions":["shell"]}', "Failed").problem.code).toBe("unsupported_problem");
});
test("worker persists events and read-only search/export retrieve the same evidence", async () => {
  const home = root(); const directory = join(home, "diagnostics", "observability");
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", home, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "launcher", environment: "test", target: "test" });
  try {
    await diagnostics.run("Review setup", async operation => { operation.problem(new DiagnosticError({ code: "setup_preview_stale", message: "Review a fresh preview" })); });
    await diagnostics.close();
    const status = await client.status(); expect(status.eventCount).toBeGreaterThanOrEqual(3);
    const query = await client.query({ view: "problems" }); expect(query.events[0]?.problem?.code).toBe("setup_preview_stale");
    const search = await queryDiagnostics(directory, { regex: "fresh preview" }); expect(search.events.some(event => event.kind === "problem")).toBe(true);
    const html = join(home, "report.html"); await exportDiagnostics(directory, { format: "html" }, html);
    expect(readFileSync(html, "utf8")).toContain("Review a fresh preview");
    expect(readFileSync(html, "utf8")).toContain("Collection health");
    expect(readFileSync(html, "utf8")).toContain("Component versions");
    expect(readFileSync(html, "utf8")).not.toContain("<script");
  } finally { await client.close(); }
  const store = new DiagnosticStore(directory, { readonly: true }); expect(store.status().eventCount).toBeGreaterThan(0); store.close();
}, 15000);
test("already-cancelled queries do not start work", async () => {
  const controller = new AbortController(); controller.abort(new Error("stop now"));
  expect(queryDiagnostics(root(), {}, controller.signal)).rejects.toThrow("stop now");
});

test("invalid and cancelled queries do not mark collection writes as lost", async () => {
  const home = root();
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", home, "diagnostics", "worker"] });
  try {
    const before = await client.status();
    await expect(client.query({ regex: "[" })).rejects.toMatchObject({ code: "invalid_query" });
    const abort = new AbortController();
    const query = client.query({}, abort.signal); abort.abort();
    await expect(query).rejects.toMatchObject({ name: "AbortError" });
    const after = await client.status();
    expect(after.dropped).toBe(before.dropped);
    expect(after.notices).toEqual(before.notices);
    expect(after.available).toBe(true);
  } finally { await client.close(); }
}, 15000);

test("independent workers share a store without losing records or claiming two private scopes", async () => {
  const home = root();
  const clients = Array.from({ length: 4 }, () => new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", home, "diagnostics", "worker"] }));
  try {
    expect((await Promise.all(clients.map(client => client.status()))).every(status => status.available)).toBe(true);
    await clients[0].capture({ action: "private-start", scope: "next-browser-turn", acknowledged: true });
    const claims = await Promise.all(clients.map((client, index) => client.claimCapture(String(index + 1).repeat(32))));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await Promise.all(clients.map(async (client, index) => {
      const diagnostics = new Diagnostics(client, { component: "test", environment: "test", target: `profile-${index}` });
      await diagnostics.run(`Concurrent task ${index}`, async () => {}); await diagnostics.close();
    }));
    const result = await clients[0].query({ view: "operations" });
    expect(result.events).toHaveLength(4);
    expect(new Set(result.events.map(event => event.target)).size).toBe(4);
  } finally { await Promise.all(clients.map(client => client.close())); }
}, 15000);
test("worker SIGTERM settles even when its parent keeps the input pipe open", async () => {
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", root(), "diagnostics", "worker"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.write(`${JSON.stringify({ id: "ready", method: "status" })}\n`);
    const reader = child.stdout.getReader();
    await reader.read(); reader.releaseLock();
    child.kill("SIGTERM");
    const result = await Promise.race([child.exited, new Promise<"timeout">(resolve => { deadline = setTimeout(() => resolve("timeout"), 1000); })]);
    expect(result).toBe(0);
  } finally { clearTimeout(deadline); child.stdin.end(); child.kill("SIGKILL"); await child.exited; }
});

test("legacy backfill yields to status and is joined on worker shutdown", async () => {
  const home = root(); const legacy = join(home, "legacy.jsonl");
  writeFileSync(legacy, Array.from({ length: 4096 }, (_, index) => JSON.stringify({ at: new Date().toISOString(), event: `legacy.event.${index}`, level: "info" })).join("\n"));
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", home, "diagnostics", "worker"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    child.stdin.write(`${JSON.stringify({ id: "import", method: "import", files: [legacy] })}\n${JSON.stringify({ id: "status", method: "status" })}\n${JSON.stringify({ id: "clear", method: "clear", scope: "normal", confirmed: true })}\n`);
    const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let text = "";
    while (text.split("\n").length < 3) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value); }
    reader.releaseLock();
    const first = JSON.parse(text.split("\n")[0]);
    expect(first.id).toBe("status"); expect(first.ok).toBe(true);
    expect(first.result.notices.join(" ")).toContain("Legacy import has not finished");
    const clear = JSON.parse(text.split("\n")[1]); expect(clear.id).toBe("clear"); expect(clear.ok).toBe(false);
    child.kill("SIGTERM"); expect(await child.exited).toBe(0);
    const store = new DiagnosticStore(join(home, "diagnostics", "observability"), { readonly: true });
    try { expect(store.status().eventCount).toBeLessThan(4096); expect(store.status().notices.join(" ")).toContain("Legacy import has not finished"); }
    finally { store.close(); }
  } finally { clearTimeout(kill); child.stdin.end(); child.kill("SIGKILL"); await child.exited; }
}, 10000);

test("cold worker startup may exceed the steady-state status deadline", async () => {
  const home = root();
  const script = `await Bun.sleep(2500); const { runDiagnosticsWorker } = await import(${JSON.stringify(resolve("src/diagnostics/worker.ts"))}); await runDiagnosticsWorker(${JSON.stringify(join(home, "diagnostics", "observability"))});`;
  const client = new DiagnosticsClient({ executable: process.execPath, args: ["-e", script] });
  try { expect((await client.status()).available).toBe(true); }
  finally { await client.close(); }
}, 15000);

test("a worker that stops reading cannot accumulate unbounded request bytes", async () => {
  const client = new DiagnosticsClient({ executable: process.execPath, args: ["-e", "process.stdin.pause(); setInterval(() => {}, 1000)"] });
  try {
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => client.request({ method: "capture-write", traceId: "a".repeat(32), png: "a".repeat(1_300_000) }, 100)));
    const busy = results.filter(result => result.status === "rejected" && String(result.reason).includes("busy"));
    expect(busy.length).toBeGreaterThan(24);
  } finally { await client.close(); }
}, 10000);
test("CLI follow drains a burst, includes a late-clock record, and stops on cancellation", async () => {
  const home = root(); const store = new DiagnosticStore(join(home, "diagnostics", "observability"));
  const makeEvent = (time = Date.now()): DiagnosticEvent => ({ version: 1, id: crypto.randomUUID(), time, kind: "log", name: "follow.fixture", body: "Safe follow fixture", severity: "info", component: "test", environment: "test", target: "fixture", attributes: {} });
  const burst = Array.from({ length: 128 }, () => makeEvent()); const late = makeEvent(Date.now() - 60_000);
  store.append(burst);
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", home, "diagnostics", "follow", "--json"], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 6000); const seen: string[] = []; let appended = false;
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }); let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const result = JSON.parse(buffer.slice(0, newline)) as { events: DiagnosticEvent[] }; buffer = buffer.slice(newline + 1);
        seen.push(...result.events.map(event => event.id));
        if (!appended) { appended = true; store.append([late]); }
        if (seen.includes(late.id) && seen.length >= 129) child.kill("SIGTERM");
      }
    }
    expect(await child.exited).toBe(0);
    expect(await stderr).toBe("");
    expect(seen.length).toBe(129);
    expect(new Set(seen)).toEqual(new Set([...burst, late].map(event => event.id)));
  } finally { clearTimeout(timeout); child.kill(); await child.exited; store.close(); }
}, 10000);

test("saturation accounts for every offered event and retains a late failure ahead of routine records", async () => {
  const home = root();
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", home, "diagnostics", "worker"] });
  try {
    const make = (severity: "info" | "error"): DiagnosticEvent => ({ version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "log", name: severity === "error" ? "critical.failure" : "routine.event", body: "Synthetic saturation record", severity, component: "test", environment: "test", target: "fixture", attributes: {} });
    for (let index = 0; index < 1050; index++) client.emit(make("info"));
    const failure = make("error"); client.emit(failure); await client.flush();
    const status = await client.status(); expect(status.eventCount + status.dropped).toBe(1051); expect(status.dropped).toBeGreaterThan(0);
    expect((await client.query({ severity: "error" })).events.map(event => event.id)).toEqual([failure.id]);
  } finally { await client.close(); }
}, 10000);

test("browser task and stage failures retain correlation without recording the thrown browser content", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "browser", target: "test", environment: "test" });
  setRuntimeDiagnostics(diagnostics);
  const prototype = ChatGptBrowserWorker.prototype as unknown as { runStage<T>(traceId: string, name: string, timeout: number, action: () => Promise<T>): Promise<T> };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" }, activeRuns: new Map(),
    runExclusive: (turn: BrowserTurn) => prototype.runStage.call({}, turn.traceId, "inspect", 1000, async () => { throw new Error("private prompt text must not appear"); }),
  }) as ChatGptBrowserWorker;
  try {
    await expect(worker.run({ traceId: "task_browser", modelId: "fixture", capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false }, prepare: async () => ({ text: "never sent", images: [], release() {} }), onTextDelta() {} })).rejects.toThrow("private prompt");
    await diagnostics.close();
    const task = events.find(event => event.name === "browser.turn" && event.span?.endTime);
    const stage = events.find(event => event.name === "browser.inspect" && event.span?.endTime);
    expect(task?.span?.outcome).toBe("failed");
    expect(stage?.parentSpanId).toBe(task?.spanId);
    expect(stage?.traceId).toBe(task?.traceId);
    expect(stage?.taskId).toBe("task_browser");
    expect(JSON.stringify(events)).not.toContain("private prompt text");
  } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
});
