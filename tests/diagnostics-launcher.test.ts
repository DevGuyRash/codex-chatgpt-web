import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as Host from "../launcher/diagnostics/host";
import { DiagnosticStore } from "../src/diagnostics/store";
import { QuerySchema } from "../src/diagnostics/contracts";

// Exercise shipped CJS, not a second handwritten Node implementation.
const host = createRequire(import.meta.url)(resolve("launcher/electron/generated/diagnostics.cjs")) as typeof Host;

test("startup findings, recovery cause and trace survive emitted-host persistence and export without raw errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-startup-"));
  const { runStartup } = createRequire(import.meta.url)(resolve("launcher/electron/startup.cjs"));
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  let traceId: string | undefined;
  try {
    await logger.ready;
    await runStartup({ logger, start: async () => {
      logger.info("runtime.stdout", { line: "PRIVATE_CHILD_OUTPUT", message: "PRIVATE_CONFIG_CONTENT", response: "PRIVATE_BROWSER_CONTENT" });
      throw new host.DiagnosticError({ code: "codex_route_verification_failed", message: "Application-owned route verification failed", findings: [{ path: "fixture.route", message: "Expected disconnected route" }] });
    }, recover: async () => { throw new Error("PRIVATE_RECOVERY_OUTPUT Bearer PRIVATE_CREDENTIAL"); }, failed: async (problem: { traceId: string }) => { traceId = problem.traceId; } });
    await logger.client!.flush();
    const store = new DiagnosticStore(join(root, "diagnostics", "observability"), { readonly: true });
    try {
      const events = store.query({ traceId }).events;
      const problem = events.find(event => event.problem)?.problem;
      expect(problem?.code).toBe("codex_route_verification_failed");
      expect(problem?.findings).toEqual([{ path: "fixture.route", message: "Expected disconnected route" }]);
      expect(problem?.recovery).toBe("incomplete");
      expect(problem?.causes[0]?.message).toContain("previous Codex route could not be restored");
      expect(events.every(event => event.traceId === traceId)).toBe(true);
      expect(events.find(event => event.name === "runtime-start-route-recovery" && event.span?.outcome === "failed")).toBeDefined();
      expect(JSON.stringify(events)).not.toContain("PRIVATE_");
    } finally { store.close(); }
    const destination = join(root, "startup-report.json");
    await logger.client!.export({ format: "json", query: { traceId } }, destination);
    const report = readFileSync(destination, "utf8");
    expect(report).toContain("Expected disconnected route");
    expect(report).toContain(traceId!);
    expect(report).not.toContain("PRIVATE_");
  } finally { await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("setup recovery distinguishes missing workflow evidence from storage failure and preserves the known owner", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let events: unknown[] = [], reviews = 0;
  const traceId = "a".repeat(32);
  const logger = { client: { query: async (query: { traceId: string }) => { expect(query.traceId).toBe(traceId); return { events }; } } } as unknown as Host.DiagnosticLogger;
  host.registerDiagnosticsIpc({ handle: (channel, handler) => { handlers.set(channel, handler); }, logger, chooseExport: async () => undefined, copyText: () => {}, reviewUpgrade: async () => { reviews++; } });
  const review = handlers.get("launcher:diagnostics-review-setup")!;
  expect(await review({}, traceId)).toEqual({ diagnosticFailure: true, code: "recovery_unavailable" });
  expect(reviews).toBe(0);
  events = [{ kind: "span", component: "launcher", name: "runtime-upgrade" }];
  expect(await review({}, traceId)).toEqual({ ok: true });
  expect(reviews).toBe(1);
});

test("cancelling one diagnostic request preserves the timeline and other renderer requests", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const signals: AbortSignal[] = [];
  const settle: Array<() => void> = [];
  const logger = { client: { query: (_query: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise(resolve => { settle.push(() => resolve({ version: 1, events: [], incomplete: false, notices: [] })); });
  } } } as unknown as Host.DiagnosticLogger;
  host.registerDiagnosticsIpc({ handle: (channel, handler) => { handlers.set(channel, handler); }, logger, chooseExport: async () => undefined, copyText: () => {} });
  const query = handlers.get("launcher:diagnostics-query")!;
  const cancel = handlers.get("launcher:diagnostics-cancel")!;
  const listId = crypto.randomUUID(), timelineId = crypto.randomUUID();
  const first = { sender: { id: 1 } }, second = { sender: { id: 2 } };
  const requests = [query(first, {}, listId), query(first, { traceId: "a".repeat(32) }, timelineId), query(second, {}, listId)];
  try {
    await cancel(first, listId);
    expect(signals.map(signal => signal.aborted)).toEqual([true, false, false]);
  } finally { settle.forEach(resolve => resolve()); await Promise.all(requests); }
});

test("an observed child crash terminalizes its unfinished spans without losing correlation", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-crash-"));
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  try {
    await logger.ready;
    const event = { version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "span", name: "child.stage", body: "Child stage started", severity: "info", component: "runtime", environment: "test", target: "fixture", traceId: "a".repeat(32), spanId: "b".repeat(16), attributes: {}, span: { startTime: Date.now(), outcome: "running" } };
    const child = spawn(process.execPath, ["-e", "import { writeSync } from 'node:fs'; writeSync(3, process.env.DIAGNOSTIC_FIXTURE + '\\n'); process.exit(7)"], { env: { ...process.env, DIAGNOSTIC_FIXTURE: JSON.stringify(event) }, stdio: ["ignore", "ignore", "ignore", "pipe"] });
    logger.attachChild(child); await once(child, "close"); await logger.client!.flush();
    const result = await logger.client!.query({ view: "operations", traceId: event.traceId });
    expect(result.events[0]?.span?.outcome).toBe("interrupted");
    expect(result.events[0]?.spanId).toBe(event.spanId);
    expect(result.events[0]?.attributes["process.exit_code"]).toBe(7);
  } finally { await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("emitted status keeps observed runtime health separate from healthy collection", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-health-"));
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  try {
    await logger.ready;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    host.registerDiagnosticsIpc({ handle: (channel, handler) => { handlers.set(channel, handler); }, logger, chooseExport: async () => undefined, copyText: () => {}, runtime: { readConfig: () => ({}), proxyHealth: async () => false } });
    const status = await handlers.get("launcher:diagnostics-status")!({}) as { available: boolean; runtime?: { state: string } };
    expect(status.available).toBe(true);
    expect(status.runtime?.state).toBe("unavailable");
  } finally { await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("emitted launcher IPC failures persist and are independently retrieved through the read-only CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-emitted-"));
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  try {
    await logger.ready;
    let registered: ((...args: unknown[]) => unknown) | undefined;
    host.registerLoggedIpc({ handle: (_channel, handler) => { registered = handler; } }, logger, "launcher:fixture-approval", async () => { throw new host.DiagnosticError({ code: "setup_preview_stale", message: "Review a fresh preview", recovery: "not-needed" }); });
    expect(await registered!({})).toMatchObject({ launcherActionFailure: true, problem: { code: "setup_preview_stale", message: "Review a fresh preview" } });
    await logger.client!.flush();
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "--home", root, "diagnostics", "list", "--view", "problems", "--json"], { stdout: "pipe", stderr: "pipe" });
    const result: unknown = JSON.parse(await new Response(child.stdout).text());
    expect(await child.exited).toBe(0);
    expect(JSON.stringify(result)).toContain("setup_preview_stale");
    const store = new DiagnosticStore(join(root, "diagnostics", "observability"), { readonly: true });
    try { expect(store.query({ view: "operations" }).events[0]?.span?.outcome).toBe("failed"); } finally { store.close(); }
  } finally { await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("retained legacy import is idempotent and excludes raw streams, browser DOM, and credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-legacy-"));
  const file = join(root, "launcher.jsonl");
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event: "browser.failed", level: "error", detail: { phase: "connector", candidates: 2, line: "private roadmap /home/private-user/secret", message: '<div>private-dom</div>', error: "private response", authorization: "Bearer secret-canary", prompt: "private prompt", url: "https://chatgpt.com/c/private-conversation?token=secret" } })}\nnot-json\n`);
  const logger = host.createLogger({ filePath: file, invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  try {
    await logger.imported;
    await logger.client!.request({ method: "import", files: [file] });
    const query = await logger.client!.query({ component: "legacy" });
    expect(query.events).toHaveLength(1);
    expect(query.events[0]?.attributes.candidates).toBe(2);
    expect(query.events[0]?.attributes.phase).toBe("connector");
    expect(query.events[0]?.traceId).toBeUndefined();
    expect(JSON.stringify(query)).not.toMatch(/private-|private prompt|private response|secret-canary/);
    const exported = join(root, "report.html");
    await logger.client!.request({ method: "export", options: { format: "html", query: QuerySchema.parse({}) }, destination: exported });
    expect(readFileSync(exported, "utf8")).not.toMatch(/private-|private prompt|private response|secret-canary/);
  } finally { await logger.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("bootstrap pipe failures remain bounded and never persist raw stream contents", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-bootstrap-"));
  const stream = new PassThrough(); const filePath = join(root, "stream.log");
  try {
    host.installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("private failure content"), { code: "EOF" }));
    expect(readFileSync(filePath, "utf8")).toContain("process.stream_failed");
    expect(readFileSync(filePath, "utf8")).not.toContain("private failure content");
  } finally { stream.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("launcher admission events preserve HTTP correlation through queueing, deferred acquisition and release in production reports", async () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-admission-"));
  const { BrowserControlServer } = createRequire(import.meta.url)(resolve("launcher/electron/control-server.cjs"));
  const logger = host.createLogger({ filePath: join(root, "launcher.jsonl"), invocation: { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] }, environment: "test" });
  const prior = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = crypto.randomUUID();
  const tabs = new Map<string, { traceId: string; helperPid: number; status: string }>();
  const browser = { turnTabs: tabs, browserInteractionMode: () => "automatic", beginTurn: async (traceId: string, _visible: boolean, helperPid: number) => { tabs.set(traceId, { traceId, helperPid, status: "running" }); return { surfaceId: `surface-${traceId}` }; }, endTurn: async (traceId: string) => { tabs.delete(traceId); return {}; } };
  const server = await new BrowserControlServer({ logger, getBrowserHost: () => browser, getPreferences: () => ({}) }).start();
  const { endpoint, token } = server.descriptor();
  const scopes = ["a", "b", "c"].map(character => ({ browser: `browser-${character}`, trace: character.repeat(32), span: character.repeat(16) }));
  const post = (index: number, phase: "start" | "end", parent?: string) => {
    const scope = scopes[index]!;
    return fetch(`${endpoint}/v1/turn/${phase}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", traceparent: parent ?? `00-${scope.trace}-${scope.span}-01` }, body: JSON.stringify({ phase, traceId: scope.browser, helperPid: process.pid, queueAware: true, proGeneration: false, ...(phase === "end" ? { status: "completed" } : {}) }) });
  };
  try {
    await logger.ready;
    expect((await post(0, "start", "invalid")).status).toBe(400);
    expect(tabs.size).toBe(0);
    for (const index of [0, 1, 2]) expect([200, 202]).toContain((await post(index, "start")).status);
    expect(tabs.size).toBe(2);
    expect((await post(0, "end")).status).toBe(200);
    // The third acquisition was started by the first task's release request.
    for (let count = 0; count < 50 && !tabs.has(scopes[2]!.browser); count++) await Bun.sleep(10);
    expect(tabs.has(scopes[2]!.browser)).toBeTrue();
    for (const index of [1, 2]) expect((await post(index, "end")).status).toBe(200);
    await logger.client!.flush();
    for (const scope of scopes) {
      const query = await logger.client!.query({ traceId: scope.trace, ascending: true, limit: 200 });
      expect(query.incomplete).toBeFalse(); expect(query.notices).toEqual([]);
      expect(query.events.map(event => event.name)).toEqual(["browser.queued", "browser.acquisition_started", "browser.acquisition_completed", "browser.admission_released"]);
      expect(query.events.every(event => event.traceId === scope.trace && event.spanId === scope.span && event.taskId === scope.browser && event.attributes.traceId === scope.browser)).toBeTrue();
      expect(query.events[0]!.attributes.capacity).toBe(2);
    }
    const destination = join(root, "admission.json");
    await logger.client!.export({ format: "json", query: { traceIds: scopes.map(scope => scope.trace) } }, destination);
    const report = readFileSync(destination, "utf8");
    for (const scope of scopes) { expect(report).toContain(scope.trace); expect(report).toContain(scope.browser); }
    expect(report).toContain("browser.admission_released");
  } finally {
    await server.close(); await logger.close();
    if (prior === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = prior;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
