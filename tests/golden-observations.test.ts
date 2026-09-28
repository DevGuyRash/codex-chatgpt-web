import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { goldenScenarioTerminations, readGoldenEvents, readGoldenAdmissionEvents, selectGoldenNativeThreadEvents, verifyGoldenModelSelections, verifyGoldenModelSequence, verifyGoldenToolReceipts, verifyGoldenRetainedTabReuse, verifyGoldenTuiTitles } from "../scripts/golden/observations";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { problemFor, DiagnosticError } from "../src/diagnostics/problems";
import { diagnosticAdmissionObservation } from "../scripts/golden/admission";
import { findNativeTuiTitleFailure, NativeTuiTitleFailure } from "../scripts/golden/tui-scenarios";
import { retainLiveProviderAdmission } from "../scripts/golden/live-batch";
import { GoldenQueue } from "../scripts/golden/queue";

test("model-switch acceptance binds each observed route to its exact native turn", async () => {
  const events: DiagnosticEvent[] = [], sink = { emit(event: DiagnosticEvent) { events.push(event); } };
  const runtime = new Diagnostics(sink, { component: "runtime", target: "fixture", environment: "test" });
  const browser = new Diagnostics(sink, { component: "browser-helper", target: "fixture", environment: "test" });
  const threadId = randomUUID(), routes = [CHATGPT_WEB_MODEL_ROUTES[1]!, CHATGPT_WEB_MODEL_ROUTES[0]!];
  const expected = routes.map(route => ({ route, turnId: randomUUID() }));
  try {
    for (const item of expected) {
      const request = runtime.begin("http.responses", {}, null, { id: `${threadId}:${item.turnId}` });
      const selection = browser.begin("browser.effort_selection", {}, request.context, { id: randomUUID() });
      const index = item.route.adapterEffort === "low" ? 0 : 1;
      selection.run(() => browser.event("browser.model_selection", "Observed fixture controls", { model: item.route.backendModel, effort: item.route.adapterEffort, control: "effort-slider", sliderMin: 0, sliderMax: 4, sliderValue: index, selectedIndex: index }));
      selection.end(); request.end();
    }
    expect(verifyGoldenModelSequence(events, threadId, expected)).toMatchObject({ passed: true, turns: 2, observedEffort: "low" });
    expect(verifyGoldenModelSequence(events, threadId, expected.map((item, index) => ({ ...item, route: routes[1 - index]! }))).passed).toBeFalse();
    expect(verifyGoldenModelSequence(events, threadId, [{ ...expected[0]!, turnId: randomUUID() }, expected[1]!]).passed).toBeFalse();
    const owner = events.find(event => event.name === "http.responses")!;
    expect(verifyGoldenModelSequence([...events, { ...owner, taskId: `${threadId}:${expected[1]!.turnId}` }], threadId, expected).passed).toBeFalse();
    expect(() => verifyGoldenModelSequence(events, threadId, [expected[0]!, expected[0]!])).toThrow("distinct bounded");
    expect(verifyGoldenModelSequence(events.filter(event => event.name !== "browser.model_selection" || event.attributes.effort !== "medium"), threadId, expected).passed).toBeFalse();
  } finally { await runtime.close(); await browser.close(); }
});

test("retained conversation proof joins two native turns to one exact launcher tab", async () => {
  const events: DiagnosticEvent[] = [], sink = { emit(event: DiagnosticEvent) { events.push(event); } };
  const runtime = new Diagnostics(sink, { component: "runtime", target: "fixture", environment: "test" });
  const browser = new Diagnostics(sink, { component: "browser-helper", target: "fixture", environment: "test" });
  const launcher = new Diagnostics(sink, { component: "launcher", target: "fixture", environment: "test" });
  const threadId = randomUUID(), turnIds = [randomUUID(), randomUUID()], tabId = "retained-fixture-tab";
  try {
    turnIds.forEach((turnId, index) => {
      const request = runtime.begin("http.responses", {}, null, { id: `${threadId}:${turnId}` });
      const browserTask = `browser-task-${index}`;
      launcher.withContext({ ...request.context, taskId: browserTask }, () => launcher.event(index === 0 ? "browser.tab_created" : "browser.tab_reused", "Owned tab", { tabId, traceId: browserTask }));
      const selection = browser.begin("browser.effort_selection", {}, request.context, { id: browserTask });
      selection.run(() => browser.event("browser.model_selection", "Owned model", { model: "gpt-5.6-sol", effort: "low" }));
      selection.end();
      launcher.withContext({ ...request.context, taskId: browserTask }, () => launcher.event("browser.tab_retained", "Owned tab", { tabId, traceId: browserTask }));
      request.end();
    });
    const selected = selectGoldenNativeThreadEvents(events, threadId);
    expect(verifyGoldenRetainedTabReuse(selected.events, threadId)).toMatchObject({ passed: true, tabId, turnIds });
    const reused = events.find(event => event.name === "browser.tab_reused")!;
    expect(verifyGoldenRetainedTabReuse(selected.events.map(event => event === reused ? { ...event, attributes: { ...event.attributes, tabId: "foreign-tab" } } : event), threadId).passed).toBeFalse();
    expect(verifyGoldenRetainedTabReuse(selected.events.map(event => event === reused ? { ...event, taskId: "foreign-browser-task" } : event), threadId).passed).toBeFalse();
    expect(verifyGoldenRetainedTabReuse(selected.events.map(event => event === reused ? { ...event, time: 0 } : event), threadId).passed).toBeFalse();
    expect(verifyGoldenRetainedTabReuse(selected.events.filter(event => event.name !== "browser.tab_retained"), threadId).passed).toBeFalse();
    expect(verifyGoldenRetainedTabReuse([...selected.events, reused], threadId).passed).toBeFalse();
  } finally { await runtime.close(); await browser.close(); await launcher.close(); }
});

test("expected interruption requires native control outcome and exact task/turn broker evidence", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => { events.push(event); } }, { component: "runtime", target: "fixture", environment: "test" });
  const threadId = randomUUID(), turnId = randomUUID();
  const terminal = { status: "completed", threadId, scenario: { variant: "stop-tools-continue", turns: [{ id: turnId, status: "interrupted" }, { id: randomUUID(), status: "completed" }], observation: { threadId, turnId, phase: "tools" } } };
  const expected = goldenScenarioTerminations("stop-tools-continue", terminal);
  const request = diagnostics.begin("http.responses", {}, null, { id: `${threadId}:${turnId}` });
  const call = diagnostics.begin("mcp.tool", { callId: "fixture-interrupted", tool: "exec_command" }, request.context, { id: "browser-fixture" });
  call.end("cancelled", { termination: "native_interrupt" }); request.end("cancelled");
  try {
    expect(verifyGoldenToolReceipts(events).passed).toBeFalse();
    expect(verifyGoldenToolReceipts(events, expected)).toMatchObject({ passed: true, returned: 0, intentionalTerminations: 1 });
    expect(verifyGoldenToolReceipts(events, [{ ...expected[0]!, turnId: randomUUID() }]).passed).toBeFalse();
    expect(verifyGoldenToolReceipts(events, [{ ...expected[0]!, threadId: randomUUID() }]).passed).toBeFalse();
    expect(verifyGoldenToolReceipts(events.map(event => event.name === "mcp.tool" ? { ...event, attributes: { ...event.attributes, termination: "timeout" } } : event), expected).passed).toBeFalse();
    const owner = events.find(event => event.name === "http.responses")!;
    expect(verifyGoldenToolReceipts([...events, { ...owner, taskId: `${threadId}:${randomUUID()}` }], expected).passed).toBeFalse();
    expect(() => goldenScenarioTerminations("stop-tools-continue", { ...terminal, scenario: { ...terminal.scenario, observation: { ...terminal.scenario.observation, turnId: randomUUID() } } })).toThrow("different native task, turn or phase");
    expect(() => goldenScenarioTerminations("stop-tools-continue", { ...terminal, scenario: { ...terminal.scenario, turns: [{ id: turnId, status: "completed" }, terminal.scenario.turns[1]] } })).toThrow("control outcome");
  } finally { await diagnostics.close(); }
});

test("steering supersession is distinct from an expected native stop", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => { events.push(event); } }, { component: "runtime", target: "fixture", environment: "test" });
  const threadId = randomUUID(), turnId = randomUUID();
  const terminal = { status: "completed", threadId, scenario: { variant: "steer-tools", turns: [{ id: turnId, status: "completed" }], observation: { threadId, turnId, phase: "tools" }, steeringWitness: "fixture-witness" } };
  const expected = goldenScenarioTerminations("steer-tools", terminal);
  const request = diagnostics.begin("http.responses", {}, null, { id: `${threadId}:${turnId}` });
  const call = diagnostics.begin("mcp.tool", { callId: "fixture-superseded", tool: "exec_command" }, request.context, { id: "browser-fixture" });
  call.end("interrupted", { termination: "superseded" }); request.end();
  try {
    expect(verifyGoldenToolReceipts(events, expected)).toMatchObject({ passed: true, returned: 0, intentionalTerminations: 1 });
    expect(verifyGoldenToolReceipts(events, [{ ...expected[0]!, termination: "native_interrupt" }]).passed).toBeFalse();
    expect(() => goldenScenarioTerminations("steer-tools", { ...terminal, scenario: { ...terminal.scenario, steeringWitness: "" } })).toThrow("control outcome");
  } finally { await diagnostics.close(); }
});

test("broker acceptance rejects duplicate invocation identities and missing returned receipts", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "runtime", target: "fixture", environment: "test" });
  const parent = diagnostics.begin("http.responses", {}, null);
  const first = diagnostics.begin("mcp.tool", { callId: "call_one", tool: "exec_command" }, parent.context, { id: "browser-one" });
  first.end();
  expect(verifyGoldenToolReceipts(events)).toMatchObject({ passed: true, calls: 1 });
  const before = events.length;
  const duplicate = diagnostics.begin("mcp.tool", { callId: "call_one", tool: "exec_command" }, parent.context, { id: "browser-one" }); duplicate.end();
  expect(verifyGoldenToolReceipts(events).passed).toBe(false);
  events.splice(before);
  const missing = diagnostics.begin("mcp.tool", { callId: "call_two", tool: "exec_command" }, parent.context, { id: "browser-one" });
  expect(verifyGoldenToolReceipts(events).passed).toBe(false);
  missing.end("cancelled");
  expect(verifyGoldenToolReceipts(events).passed).toBe(false);
  parent.end(); await diagnostics.close();
});

test("concurrent native tasks cannot borrow each other's model-selection evidence", async () => {
  const events: DiagnosticEvent[] = [];
  const sink = { emit(event: DiagnosticEvent) { events.push(event); } };
  const runtime = new Diagnostics(sink, { component: "golden", target: "fixture", environment: "test" });
  const browser = new Diagnostics(sink, { component: "browser-helper", target: "fixture", environment: "test" });
  const route = CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/light")!;
  const threads = [randomUUID(), randomUUID()];
  try {
    for (const thread of threads) {
      const request = runtime.begin("http.responses", {}, null);
      request.identify({ id: `${thread}:${randomUUID()}` });
      const selection = browser.begin("browser.effort_selection", {}, request.context, { id: randomUUID() });
      selection.run(() => browser.event("browser.model_selection", "Browser model controls confirmed", { model: route.backendModel, effort: route.adapterEffort, control: "effort-slider", sliderMin: 0, sliderMax: 4, sliderValue: 0, selectedIndex: 0 }));
      selection.end(); request.end();
    }
    const selected = selectGoldenNativeThreadEvents(events, threads[0]);
    expect(verifyGoldenModelSelections(selected.events, route, 1).passed).toBe(true);
    expect(verifyGoldenModelSelections(selected.events, route, 2).passed).toBe(false);
    expect(selected.traceIds.length).toBe(1);
    expect(selected.turnIds.length).toBe(1);
    const otherBrowserTask = events.find(event => event.name === "browser.model_selection" && event.traceId !== selected.traceIds[0])!.taskId!;
    const wrongReceipt = runtime.begin("mcp.tool", { callId: "other-task-call", tool: "exec_command" }, { traceId: selected.traceIds[0], spanId: "a".repeat(16) }, { id: otherBrowserTask });
    wrongReceipt.end();
    expect(() => selectGoldenNativeThreadEvents(events, threads[0])).toThrow("another browser task");
    expect(() => selectGoldenNativeThreadEvents(events, randomUUID())).toThrow("no correlated");
    const claimed = events.find(event => event.name === "http.responses" && event.taskId?.startsWith(threads[0]))!;
    expect(() => selectGoldenNativeThreadEvents([...events, { ...claimed, taskId: `${threads[1]}:${randomUUID()}` }], threads[0])).toThrow("multiple native tasks");
  } finally { await runtime.close(); await browser.close(); }
});

test("selection acceptance reads the selected campaign across production query pages and checks observed controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-observations-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "browser-helper", target: "fixture", environment: "test" });
  const route = CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/light")!;
  const campaignId = randomUUID();
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 7200000 });
    const observer = diagnostics.begin("golden.acceptance", {}, null);
    await client.contentCapture({ action: "bind", campaignId, traceId: observer.context.traceId });
    const other = diagnostics.begin("fixture.other", {}, null, { id: "other" });
    other.run(() => diagnostics.event("browser.model_selection", "Other scope must not count", {})); other.end();
    for (let index = 0; index < 3; index++) {
      const turn = diagnostics.begin("browser.effort_selection", {}, null, { id: `turn-${index}` });
      await client.contentCapture({ action: "bind", campaignId, traceId: turn.context.traceId });
      turn.run(() => {
        for (let n = 0; n < 75; n++) diagnostics.event("fixture.progress", "Synthetic event", { index, n });
        diagnostics.event("browser.model_selection", "Browser model controls confirmed", { model: route.backendModel, effort: route.adapterEffort, control: "effort-slider", sliderMin: 0, sliderMax: 4, sliderValue: 0, selectedIndex: 0 });
      });
      turn.end();
    }
    const { events } = await readGoldenEvents(client, campaignId, { observerTraceId: observer.context.traceId });
    expect(events.some(event => event.traceId === observer.context.traceId)).toBe(false);
    expect(events.length).toBeGreaterThan(200);
    expect(events.some(event => event.traceId === other.context.traceId)).toBe(false);
    expect(verifyGoldenModelSelections(events, route, 3)).toMatchObject({ passed: true, turns: 3, observedModel: route.backendModel });
    expect(verifyGoldenModelSelections(events, route, 4)).toMatchObject({ passed: false });
    const wrongIndex = events.map(event => event.name === "browser.model_selection" ? { ...event, attributes: { ...event.attributes, sliderValue: 1 } } : event);
    const wrong = verifyGoldenModelSelections(wrongIndex, route, 3);
    expect(wrong.passed).toBe(false); expect(wrong.observedModel).toBeUndefined();
    expect(verifyGoldenModelSelections(events.filter(event => event.name !== "browser.model_selection"), route, 1).passed).toBe(false);
    expect(verifyGoldenModelSelections(events.map(event => ({ ...event, taskId: undefined })), route, 1).passed).toBe(false);
    await expect(readGoldenEvents(client, campaignId)).rejects.toThrow("incomplete evidence");
    observer.end();
    expect((await readGoldenEvents(client, campaignId)).events.some(event => event.traceId === observer.context.traceId)).toBe(true);
    const lost = diagnostics.begin("fixture.capture_failure", {}, null);
    await client.contentCapture({ action: "bind", campaignId, traceId: lost.context.traceId });
    lost.run(() => diagnostics.event("capture.campaign_failed", "Synthetic transport lost the capture acknowledgement", { category: "tool-result" }, "error"));
    lost.end();
    await expect(readGoldenEvents(client, campaignId)).rejects.toThrow("content capture failed");
    const failure = await readGoldenEvents(client, campaignId).catch(error => error);
    expect(problemFor(failure)).toMatchObject({ code: "golden_evidence_incomplete", origin: "diagnostics", stage: "capture_manifest", evidenceMissing: expect.stringContaining("Required campaign content") });
  } finally { await diagnostics.close(); await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);

test("TUI title acceptance requires separate provider settlement and shared admission, not merely native idle", async () => {
  const events: DiagnosticEvent[] = [], sink = { emit: (event: DiagnosticEvent) => { events.push(event); } };
  const runtime = new Diagnostics(sink, { component: "runtime", environment: "test", target: "fixture" });
  const browser = new Diagnostics(sink, { component: "browser-helper", environment: "test", target: "fixture" });
  const launcher = new Diagnostics(sink, { component: "launcher", environment: "test", target: "fixture" });
  const parent = randomUUID(), title = { threadId: randomUUID(), active: true, idle: true }, turnId = randomUUID(), route = CHATGPT_WEB_MODEL_ROUTES[0]!;
  const request = runtime.begin("http.responses", {}, null, { id: `${title.threadId}:${turnId}` });
  const selection = browser.begin("browser.effort_selection", {}, request.context, { id: "browser-title" });
  selection.run(() => browser.event("browser.model_selection", "Synthetic selected effort", { model: route.backendModel, effort: route.adapterEffort, control: "effort-slider", sliderMin: 0, sliderMax: 4, sliderValue: 0, selectedIndex: 0 }));
  for (const name of ["browser.queued", "browser.acquisition_started", "browser.acquisition_completed", "browser.admission_released"]) launcher.event(name, "Synthetic admission event", { traceId: "browser-title", ...(name === "browser.queued" ? { capacity: 2 } : {}) }, "info", selection.context);
  selection.end(); request.end();
  try {
    expect(verifyGoldenTuiTitles(events, parent, [title], route)).toMatchObject({ passed: true, titles: [{ passed: true, requests: 1, browserTurns: 1, turnIds: [turnId] }] });
    expect(verifyGoldenTuiTitles(events, parent, [{ ...title, active: false }], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events, title.threadId, [title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events, parent, [title, title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events.filter(event => event.name !== "browser.admission_released"), parent, [title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events.map(event => event.component === "launcher" && event.kind === "log" ? { ...event, traceId: undefined, taskId: undefined } : event), parent, [title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events.map(event => event.name === "browser.queued" ? { ...event, attributes: { ...event.attributes, capacity: 5 } } : event), parent, [title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events.filter(event => event.name !== "http.responses" || !event.span?.endTime), parent, [title], route).passed).toBeFalse();
    expect(verifyGoldenTuiTitles(events.map(event => event.name === "http.responses" && event.span?.endTime ? { ...event, span: { ...event.span, outcome: "failed" as const } } : event), parent, [title], route).passed).toBeFalse();
  } finally { await runtime.close(); await browser.close(); await launcher.close(); }
});

test("a scoped ancillary rate limit constrains admission despite missing content and cannot be borrowed from another task", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-ancillary-admission-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "runtime", target: "fixture", environment: "test" });
  const campaignId = randomUUID(), threadId = randomUUID(), turnId = randomUUID();
  const queue = new GoldenQueue(join(root, "campaign.sqlite"), { snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: false } }, implementationSha256: "b".repeat(64) });
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 7200000 });
    const observer = diagnostics.begin("golden.acceptance", {}, null), request = diagnostics.begin("http.responses", {}, null, { id: `${threadId}:${turnId}` });
    for (const operation of [observer, request]) await client.contentCapture({ action: "bind", campaignId, traceId: operation.context.traceId });
    request.run(() => diagnostics.problem(new DiagnosticError({ code: "rate_limit_exceeded", message: "Synthetic account limit", httpStatus: 429, origin: "chatgpt-http" })));
    request.end("failed");
    await client.contentCapture({ action: "omit", campaignId, traceId: request.context.traceId, reason: "surface-excluded" });
    await expect(readGoldenEvents(client, campaignId, { observerTraceId: observer.context.traceId })).rejects.toMatchObject({ code: "golden_evidence_incomplete" });
    const observed = await readGoldenAdmissionEvents(client, campaignId, observer.context.traceId);
    const failure = findNativeTuiTitleFailure(new AggregateError([new Error("Synthetic cleanup failure"), new NativeTuiTitleFailure(threadId)]))!;
    const observation = diagnosticAdmissionObservation(observed.events, [failure.threadId], join(root, "title-admission.json"));
    expect(observation).toMatchObject({ code: "rate_limit_exceeded", threadId, turnId });
    expect(diagnosticAdmissionObservation(observed.events.map(event => event.problem ? { ...event, problem: { ...event.problem, origin: "chatgpt-ui" } } : event), [threadId], "/fixture/evidence.zip")).toBeUndefined();
    const input = { root, campaignId, observerTraceId: observer.context.traceId, ownedThreadIds: [failure.threadId], evidencePath: observation!.evidence };
    expect(await retainLiveProviderAdmission(client, { ...input, ownedThreadIds: [randomUUID()] })).toBeUndefined();
    expect(queue.summary().admissionHold).toBeUndefined();
    expect(await retainLiveProviderAdmission(client, input)).toEqual(observation);
    expect(queue.summary().admissionHold).toMatchObject({ code: "rate_limit_exceeded", threadId, turnId });
    expect(diagnosticAdmissionObservation(observed.events, [randomUUID()], "/fixture/evidence.zip")).toBeUndefined();
    const owner = observed.events.find(event => event.name === "http.responses")!;
    expect(diagnosticAdmissionObservation([...observed.events, { ...owner, taskId: `${randomUUID()}:${turnId}` }], [threadId], "/fixture/evidence.zip")).toBeUndefined();
    expect(diagnosticAdmissionObservation(observed.events.map(event => event.problem ? { ...event, problem: { ...event.problem, code: "other", message: "rate_limit_exceeded 429" } } : event), [threadId], "/fixture/evidence.zip")).toBeUndefined();
    observer.end();
  } finally { await diagnostics.close(); await client.close(); queue.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
