import type { DiagnosticsClient } from "../../src/diagnostics/client";
import { ContentManifestSchema, type DiagnosticEvent } from "../../src/diagnostics/contracts";
import { CHATGPT_WEB_LUNA_BACKEND_MODEL, type ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { DiagnosticError } from "../../src/diagnostics/problems";

const nativeUuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
export interface GoldenToolTermination { threadId: string; turnId: string; termination: "native_interrupt" | "superseded" }

/** Successful native control evidence narrows which interrupted invocations a scenario expects. */
export function goldenScenarioTerminations(variant: string, terminal: unknown): GoldenToolTermination[] {
  const phase = /^(steer|stop)-(reasoning|generation|tools)(?:-continue)?$/.exec(variant);
  const planInterrupt = variant === "plan-stream-interrupt";
  if (!phase && !planInterrupt) return [];
  if (!object(terminal) || terminal.status !== "completed" || typeof terminal.threadId !== "string" || !nativeUuid.test(terminal.threadId)
    || !object(terminal.scenario) || terminal.scenario.variant !== variant || !Array.isArray(terminal.scenario.turns)
    || !object(terminal.scenario.observation)) throw new Error("Expected tool termination lacks completed native scenario evidence");
  const scenario = terminal.scenario, observation = scenario.observation as ObjectValue;
  const turns = scenario.turns as unknown[], first = turns[0];
  if (!object(first) || typeof first.id !== "string" || !nativeUuid.test(first.id)
    || observation.threadId !== terminal.threadId || observation.turnId !== first.id || observation.phase !== (phase?.[2] ?? "generation")) throw new Error("Expected tool termination belongs to a different native task, turn or phase");
  const steering = phase?.[1] === "steer";
  if (steering ? turns.length !== 1 || first.status !== "completed" || typeof scenario.steeringWitness !== "string" || !scenario.steeringWitness
    : turns.length !== 2 || first.status !== "interrupted" || !object(turns[1]) || turns[1].status !== "completed"
      || typeof turns[1].id !== "string" || !nativeUuid.test(turns[1].id) || turns[1].id === first.id) throw new Error("Expected tool termination lacks its matching native control outcome");
  return [{ threadId: terminal.threadId, turnId: first.id, termination: steering ? "superseded" : "native_interrupt" }];
}

/** HTTP ownership is recorded by the production identity binder, independently of browser task IDs. */
export function selectGoldenNativeThreadEvents(events: readonly DiagnosticEvent[], threadId: string) {
  if (!nativeUuid.test(threadId)) throw new Error("Native evidence selection requires the captured task UUID");
  const owners = new Map<string, Set<string>>(), traceIds = new Set<string>(), turnIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== "span" || !["http.responses", "http.compact"].includes(event.name) || !event.traceId || !event.taskId) continue;
    const [thread, turn, extra] = event.taskId.split(":");
    if (!thread || !turn || extra !== undefined || !nativeUuid.test(thread) || !nativeUuid.test(turn)) continue;
    const known = owners.get(event.traceId) ?? new Set<string>();
    known.add(thread); owners.set(event.traceId, known);
    if (thread === threadId) { traceIds.add(event.traceId); turnIds.add(turn); }
  }
  if (!traceIds.size) throw new Error("The native task has no correlated HTTP evidence");
  if ([...traceIds].some(trace => owners.get(trace)!.size !== 1)) throw new Error("A diagnostic trace claims multiple native tasks");
  const selected = events.filter(event => event.traceId && traceIds.has(event.traceId));
  const browserTasks = new Set(selected.filter(event => event.name === "browser.model_selection" && event.component === "browser-helper" && event.taskId).map(event => `${event.traceId}:${event.taskId}`));
  if (selected.some(event => event.name === "mcp.tool" && !browserTasks.has(`${event.traceId}:${event.taskId}`))) throw new Error("A native trace contains tool evidence from another browser task or lacks its browser ownership evidence");
  return { events: selected, traceIds: [...traceIds], turnIds: [...turnIds] };
}

/** Verify observed broker invocation/receipt identities, not uninstrumented external side effects. */
export function verifyGoldenToolReceipts(events: readonly DiagnosticEvent[], expectedTerminations: readonly GoldenToolTermination[] = []) {
  const failures: string[] = [], stages = new Map<string, DiagnosticEvent[]>(), calls = new Set<string>();
  const nativeOwners = new Map<string, Set<string>>();
  let returned = 0, intentionalTerminations = 0;
  for (const event of events) {
    if (event.kind !== "span" || !["http.responses", "http.compact"].includes(event.name) || !event.traceId || !event.taskId) continue;
    const owners = nativeOwners.get(event.traceId) ?? new Set<string>(); owners.add(event.taskId); nativeOwners.set(event.traceId, owners);
  }
  for (const event of events.filter(event => event.name === "mcp.tool")) {
    if (event.kind !== "span" || !event.traceId || !event.spanId || !event.taskId || typeof event.attributes.callId !== "string" || !event.attributes.callId) { failures.push("A broker tool record lacks invocation identity"); continue; }
    const key = `${event.traceId}:${event.spanId}`, stage = stages.get(key) ?? [];
    stage.push(event); stages.set(key, stage);
  }
  if (!stages.size) failures.push("No broker tool invocation evidence was observed");
  for (const stage of stages.values()) {
    const first = stage[0]!, identity = `${first.traceId}:${first.taskId}:${first.attributes.callId}`;
    if (calls.has(identity)) failures.push("A broker tool invocation identity was executed more than once");
    calls.add(identity);
    if (stage.some(event => event.taskId !== first.taskId || event.attributes.callId !== first.attributes.callId)) failures.push("A broker tool stage changed invocation identity");
    const starts = stage.filter(event => event.span?.outcome === "running"), terminal = stage.filter(event => event.span?.endTime !== undefined);
    if (starts.length !== 1 || terminal.length !== 1) { failures.push("A broker tool invocation lacks one definitive terminal outcome"); continue; }
    const result = terminal[0]!, outcome = result.span?.outcome;
    if (outcome === "succeeded" || outcome === "failed") { returned++; continue; }
    const owners = nativeOwners.get(first.traceId!);
    const intended = expectedTerminations.some(expected => ["native_interrupt", "superseded"].includes(expected.termination) && nativeUuid.test(expected.threadId) && nativeUuid.test(expected.turnId)
      && owners?.size === 1 && owners.has(`${expected.threadId}:${expected.turnId}`)
      && result.attributes.termination === expected.termination
      && outcome === (expected.termination === "native_interrupt" ? "cancelled" : "interrupted"));
    if (intended) intentionalTerminations++;
    else failures.push("A broker tool invocation lacks a returned receipt or an attributable expected termination");
  }
  return { passed: !failures.length, failures, calls: calls.size, stages: stages.size, returned, intentionalTerminations };
}

/** Read one bounded campaign through production queries, preserving the worker's snapshot. */
export async function readGoldenEvents(client: Pick<DiagnosticsClient, "flush" | "contentCapture" | "query">, campaignId: string, options: { observerTraceId?: string } = {}) {
  await client.flush();
  const manifest = ContentManifestSchema.parse(await client.contentCapture({ action: "manifest", campaignId }));
  if (manifest.omitted || manifest.collectionFailures || manifest.documents.some(document => document.status !== "stored")) throw new DiagnosticError({ code: "golden_evidence_incomplete", message: "Campaign content capture failed or remains incomplete", origin: "diagnostics", stage: "capture_manifest", findings: [{ message: `omitted=${manifest.omitted}; collectionFailures=${manifest.collectionFailures}; unstoredDocuments=${manifest.documents.filter(document => document.status !== "stored").length}` }], evidenceMissing: "Required campaign content is unavailable; retained terminal evidence does not establish full acceptance." });
  const result = await readScopedEvents(client, manifest.traceIds, options.observerTraceId);
  if (result.events.some(event => event.name === "capture.campaign_failed" || event.name === "capture.campaign_result" && !["stored", "stored-document"].includes(String(event.attributes.result)))) throw new Error("Campaign content capture failed despite retained diagnostic events");
  return result;
}

/** Admission can be constrained by structural evidence even when content capture is incomplete. */
export async function readGoldenAdmissionEvents(client: Pick<DiagnosticsClient, "flush" | "contentCapture" | "query">, campaignId: string, observerTraceId: string) {
  await client.flush();
  const manifest = ContentManifestSchema.parse(await client.contentCapture({ action: "manifest", campaignId }));
  return readScopedEvents(client, manifest.traceIds, observerTraceId, ["span", "problem"]);
}

async function readScopedEvents(client: Pick<DiagnosticsClient, "query">, boundTraceIds: readonly string[], observerTraceId?: string, kinds?: ("span" | "problem")[]) {
  if (observerTraceId && !boundTraceIds.includes(observerTraceId)) throw new Error("The acceptance observer must belong to this campaign");
  // The observer cannot finish before checking producers. Its trace remains bound to
  // the complete export, which is checked after the observer itself has settled.
  const traceIds = boundTraceIds.filter(trace => trace !== observerTraceId);
  if (!traceIds.length) throw new Error("The campaign has no bound producer diagnostic traces");
  const events: DiagnosticEvent[] = [], cursors = new Set<string>();
  let cursor: string | undefined, snapshotSequence: number | undefined;
  do {
    // The production cursor pins its initial snapshot; adding a new filter on later pages
    // changes that cursor's query identity.
    const page = await client.query({ view: "events", traceIds, ...(kinds ? { kinds } : {}), ascending: true, limit: 200, cursor });
    if (page.incomplete || page.notices.length) throw new Error("Campaign diagnostic queries reported incomplete evidence");
    if (snapshotSequence !== undefined && page.snapshotSequence !== snapshotSequence) throw new Error("Campaign diagnostic snapshot changed during inspection");
    snapshotSequence = page.snapshotSequence;
    events.push(...page.events);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 255)) throw new Error("Campaign event inspection exceeded its bounded cursor traversal");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { events, snapshotSequence };
}

/** This establishes browser control selection only, never provider internals or whole-cell acceptance. */
export function verifyGoldenModelSelections(events: readonly DiagnosticEvent[], route: ChatGptWebModelRoute, minimumTurns: number) {
  if (!Number.isSafeInteger(minimumTurns) || minimumTurns < 1) throw new Error("Selection evidence requires a positive expected turn count");
  const selected = events.filter(event => event.name === "browser.model_selection" && event.component === "browser-helper");
  const failures: string[] = [];
  const turns = new Set<string>();
  for (const event of selected) {
    const value = event.attributes;
    if (event.kind !== "log" || !event.traceId || !event.taskId || !event.spanId) { failures.push("A browser selection lacks turn correlation"); continue; }
    turns.add(`${event.traceId}:${event.taskId}`);
    if (value.model !== route.backendModel || value.effort !== route.adapterEffort) failures.push("Observed browser model or effort differs from the requested route");
    if (value.control === "effort-slider") {
      if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) failures.push("A Luna route cannot be established by the Sol slider");
      const index = ({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 } as Record<string, number>)[route.adapterEffort];
      if (typeof value.sliderMin !== "number" || typeof value.sliderMax !== "number" || typeof value.sliderValue !== "number"
        || !Number.isSafeInteger(value.sliderMin) || !Number.isSafeInteger(value.sliderMax) || !Number.isSafeInteger(value.sliderValue)
        || value.sliderMax < value.sliderMin || value.sliderValue < value.sliderMin || value.sliderValue > value.sliderMax
        || value.selectedIndex !== index || value.sliderValue - value.sliderMin !== index) failures.push("The observed slider does not prove the requested effort index");
    } else if (value.control === "luna-think") {
      if (route.backendModel !== CHATGPT_WEB_LUNA_BACKEND_MODEL || !["low", "medium"].includes(route.adapterEffort) || value.thinkEnabled !== (route.adapterEffort === "medium")) failures.push("The observed Think control does not prove the requested effort");
    } else failures.push("The browser selection has no recognized observed control");
  }
  if (turns.size < minimumTurns) failures.push("There are too few independently identified browser selections");
  return { passed: !failures.length, failures, turns: turns.size, eventIds: selected.map(event => event.id), ...(!failures.length ? { observedModel: route.backendModel, observedEffort: route.adapterEffort } : {}) };
}

/** A route change is proved per native turn, never by mixing selections across a task. */
export function verifyGoldenModelSequence(events: readonly DiagnosticEvent[], threadId: string, expected: readonly { turnId: string; route: ChatGptWebModelRoute }[]) {
  if (!nativeUuid.test(threadId) || !expected.length || expected.length > 16 || expected.some(item => !nativeUuid.test(item.turnId)) || new Set(expected.map(item => item.turnId)).size !== expected.length) throw new Error("Model sequence requires distinct bounded native turn identities");
  const selected = selectGoldenNativeThreadEvents(events, threadId);
  const owners = new Map<string, Set<string>>();
  for (const event of selected.events) {
    if (event.kind !== "span" || !["http.responses", "http.compact"].includes(event.name) || !event.traceId || !event.taskId) continue;
    const values = owners.get(event.traceId) ?? new Set<string>(); values.add(event.taskId); owners.set(event.traceId, values);
  }
  const allowed = new Set(expected.map(item => `${threadId}:${item.turnId}`)), failures: string[] = [];
  if ([...owners.values()].some(values => values.size !== 1 || !allowed.has([...values][0]!))) failures.push("A model sequence trace has ambiguous or unexpected native turn ownership");
  const sequence = expected.map(item => {
    const traces = new Set([...owners].filter(([, values]) => values.size === 1 && values.has(`${threadId}:${item.turnId}`)).map(([trace]) => trace));
    const result = verifyGoldenModelSelections(selected.events.filter(event => event.traceId && traces.has(event.traceId)), item.route, 1);
    failures.push(...result.failures);
    return { turnId: item.turnId, routeSlug: item.route.slug, ...result };
  });
  const final = expected.at(-1)!.route;
  return { passed: !failures.length, failures, turns: sequence.reduce((sum, item) => sum + item.turns, 0), eventIds: sequence.flatMap(item => item.eventIds), sequence,
    ...(!failures.length ? { observedModel: final.backendModel, observedEffort: final.adapterEffort } : {}) };
}

/** Ephemeral title lifecycle is distinct from native turn completion; HTTP and admission records prove provider settlement. */
export function verifyGoldenTuiTitles(events: readonly DiagnosticEvent[], parentThreadId: string, titles: readonly { threadId: string; active: boolean; idle: boolean }[], route: ChatGptWebModelRoute) {
  const failures: string[] = [];
  if (!nativeUuid.test(parentThreadId) || !titles.length || titles.length > 4 || new Set(titles.map(title => title.threadId)).size !== titles.length) failures.push("TUI title tasks lack distinct bounded native identities");
  const results = titles.slice(0, 4).map(title => {
    const titleFailures: string[] = [];
    if (!nativeUuid.test(title.threadId) || title.threadId === parentThreadId || !title.active || !title.idle) titleFailures.push("TUI title work lacks its separate active-to-idle lifecycle");
    let selected: ReturnType<typeof selectGoldenNativeThreadEvents> | undefined;
    try { selected = selectGoldenNativeThreadEvents(events, title.threadId); }
    catch { titleFailures.push("TUI title work lacks attributable HTTP evidence"); }
    const owned = selected?.events ?? [], selections = verifyGoldenModelSelections(owned, route, 1);
    titleFailures.push(...selections.failures);
    if (selected?.turnIds.length !== 1) titleFailures.push("TUI title work lacks one attributable native provider turn");
    const requests = new Map<string, DiagnosticEvent[]>();
    for (const event of owned) if (event.kind === "span" && event.name === "http.responses" && event.spanId) {
      const key = `${event.traceId}:${event.spanId}`, records = requests.get(key) ?? []; records.push(event); requests.set(key, records);
    }
    if (!requests.size) titleFailures.push("TUI title work has no provider request");
    for (const records of requests.values()) {
      const started = records.filter(event => event.span?.outcome === "running"), ended = records.filter(event => event.span?.endTime !== undefined);
      if (started.length !== 1 || ended.length !== 1 || ended[0]!.span?.outcome !== "succeeded") titleFailures.push("TUI title provider work lacks one successful terminal outcome");
    }
    const browserTurns = new Map(owned.filter(event => event.name === "browser.model_selection" && event.component === "browser-helper" && event.traceId && event.taskId).map(event => [`${event.traceId}:${event.taskId}`, event]));
    for (const selection of browserTurns.values()) {
      const admission = owned.filter(event => event.component === "launcher" && event.traceId === selection.traceId && event.taskId === selection.taskId && event.attributes.traceId === selection.taskId);
      const queued = admission.filter(event => event.name === "browser.queued");
      if (queued.length !== 1 || queued[0]!.attributes.capacity !== 2 || ["browser.acquisition_started", "browser.acquisition_completed", "browser.admission_released"].some(name => admission.filter(event => event.name === name).length !== 1)) titleFailures.push("TUI title work lacks shared two-generation admission and release evidence");
      if (admission.some(event => ["browser.acquired_owner_reaped", "browser.acquisition_failed", "browser.queue_expired", "browser.queue_cancelled"].includes(event.name))) titleFailures.push("TUI title admission did not settle normally");
    }
    const receipts = owned.some(event => event.name === "mcp.tool") ? verifyGoldenToolReceipts(owned) : undefined;
    if (receipts) titleFailures.push(...receipts.failures);
    failures.push(...titleFailures);
    return { threadId: title.threadId, turnIds: selected?.turnIds ?? [], traceIds: selected?.traceIds ?? [], selections, requests: requests.size, browserTurns: browserTurns.size, ...(receipts ? { receipts } : {}), passed: !titleFailures.length, failures: titleFailures };
  });
  return { passed: !failures.length, failures, titles: results };
}
