import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GOLDEN_UNICODE_WITNESS } from "../scripts/golden/workloads";
import { buildGoldenMatrix } from "../scripts/golden/catalog";
import { canExecuteLiveCell, liveBatchOutcomes, liveCampaignExecutor } from "../scripts/golden/live-campaign";
import { nativePlanHashes } from "../scripts/golden/app-server";
import { DiagnosticError, problemFor } from "../src/diagnostics/problems";

const matrix = buildGoldenMatrix({ inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: true } });
const cells = matrix.filter(cell => canExecuteLiveCell(cell) && cell.workload === 1 && cell.protocol === "native" && cell.lane === "concurrent" && cell.variant.id === "fresh").slice(0, 2);
function completedBatch(): Parameters<typeof liveBatchOutcomes>[1] {
  return { protocol: "native", incomplete: false, evidenceExport: "complete", bundleSha256: "a".repeat(64), evidence: "/fixture/bundle.zip", cells: cells.map((cell, index) => ({
    id: cell.id, routeSlug: cell.route.slug, workload: cell.workload, variant: cell.variant.id, work: `/fixture/${cell.id}`, traceId: String(index + 1).repeat(32), passed: true,
    result: { terminal: { status: "completed", threadId: `00000000-0000-4000-8000-00000000000${index + 1}`, variant: "fresh", toolItems: 1, terminal: { type: "turn.completed" }, observedItems: 2, exit: { code: 0, signal: null } },
      oracle: { passed: true, failures: [], pendingChecks: [], artifacts: [{ path: "output/result.json", bytes: 2, sha256: "b".repeat(64) }] }, commit: { passed: true, failures: [], clean: true, baseline: "a".repeat(40), head: "b".repeat(40) } },
    selections: { passed: true, failures: [], turns: 1, eventIds: ["00000000-0000-4000-8000-000000000002"], observedModel: cell.route.backendModel, observedEffort: cell.route.adapterEffort }, receipts: { passed: true, failures: [], calls: 1, stages: 1, returned: 1, intentionalTerminations: 0 },
  })) };
}

test("format settlement requires document, image and transformed output evidence at level one", () => {
  const formatCells = cells.map(cell => ({ ...cell, variant: { id: "formats", driver: "exec" as const } }));
  expect(formatCells.every(canExecuteLiveCell)).toBeTrue();
  const batch = completedBatch();
  for (const item of batch.cells) item.variant = "formats";
  expect(() => liveBatchOutcomes(formatCells, batch)).toThrow("Format coverage lacks");
  for (const item of batch.cells) for (const path of ["input/dispatch.pdf", "input/dispatch.docx", "input/dispatch.xlsx", "input/label.png", "output/attachments.json", "output/teams.csv"]) item.result!.oracle.artifacts.push({ path, bytes: 10, sha256: "c".repeat(64) });
  expect([...liveBatchOutcomes(formatCells, batch).values()].every(outcome => outcome.status === "passed")).toBeTrue();
});

test("live campaign settlement separates failed artifacts from missing terminal or export evidence", () => {
  const complete = completedBatch();
  expect([...liveBatchOutcomes(cells, complete).values()].map(outcome => outcome.status)).toEqual(["passed", "passed"]);
  const rejected = completedBatch(); rejected.cells[0].passed = false; rejected.cells[0].result!.oracle.passed = false;
  expect([...liveBatchOutcomes(cells, rejected).values()].map(outcome => outcome.status)).toEqual(["failed", "passed"]);
  const uncertain = completedBatch(); uncertain.cells[0].passed = false; delete uncertain.cells[0].result;
  expect(() => liveBatchOutcomes(cells, uncertain)).toThrow("terminal evidence");
  expect(() => liveBatchOutcomes(cells, { ...complete, incomplete: true })).toThrow("reconciliation");
  expect(() => liveBatchOutcomes(cells, { ...complete, cells: [complete.cells[0], complete.cells[0]] })).toThrow("exact owned");
  expect(() => liveBatchOutcomes(cells, { ...complete, protocol: "compatibility-v1" })).toThrow("exact claimed");
  const noReceipt = completedBatch(); delete noReceipt.cells[0].receipts;
  expect(() => liveBatchOutcomes(cells, noReceipt)).toThrow("independent evidence");
  const sameThread = completedBatch(); sameThread.cells[1].result!.terminal.threadId = sameThread.cells[0].result!.terminal.threadId;
  expect(() => liveBatchOutcomes(cells, sameThread)).toThrow("shared producer");
  const resumedCells = cells.map(cell => ({ ...cell, variant: { id: "resumed", driver: "exec" as const } }));
  const forgedResume = completedBatch();
  for (const item of forgedResume.cells) item.variant = "resumed";
  expect(() => liveBatchOutcomes(resumedCells, forgedResume)).toThrow("independent evidence");
  for (const item of forgedResume.cells) item.selections!.turns = 2;
  expect(() => liveBatchOutcomes(resumedCells, forgedResume)).toThrow("completed preparation");
});

test("complete evidence blocks a known failed native terminal without replaying its tools", () => {
  const batch = completedBatch();
  const item = batch.cells[0]!;
  item.passed = false;
  delete item.result;
  item.error = problemFor(new DiagnosticError({ code: "chatgpt_completion_unconfirmed", message: "Exact assistant turn had no completed footer", origin: "chatgpt-ui", retryable: false }));
  item.nativeFailure = { threadId: "owned-task", turns: [{ id: "submitted-turn", status: "failed", items: [] }] };
  expect([...liveBatchOutcomes(cells, batch).values()].map(outcome => outcome.status)).toEqual(["blocked", "passed"]);
  expect(liveBatchOutcomes(cells, batch).get(item.id)).toMatchObject({ status: "blocked", evidence: batch.evidence, reason: expect.stringContaining("chatgpt_completion_unconfirmed") });
  item.nativeFailure.turns[0]!.status = "inProgress";
  expect(() => liveBatchOutcomes(cells, batch)).toThrow("Native terminal evidence requires reconciliation");

  delete item.nativeFailure;
  item.nativeExecFailure = { phase: "execution", outcome: { threadId: "owned-task", status: "failed", terminal: { type: "turn.failed", error: { message: "Synthetic unconfirmed completion" } }, observedItems: 1, exit: { code: 1, signal: null } } };
  expect(liveBatchOutcomes(cells, batch).get(item.id)?.status).toBe("blocked");
  const missingEvidence = { ...batch, evidence: undefined } as unknown as Parameters<typeof liveBatchOutcomes>[1];
  expect(() => liveBatchOutcomes(cells, missingEvidence)).toThrow("Native terminal evidence requires reconciliation");
});

test("live campaign admission refuses Pro, sustained and unimplemented scenarios without model work", async () => {
  const executor = liveCampaignExecutor({ root: "/nonexistent", sourceHome: "/nonexistent", executable: "/nonexistent", turnTimeoutMs: 1000 });
  for (const cell of [matrix.find(cell => cell.exclusion?.includes("Pro generation"))!, matrix.find(cell => cell.workload === 5)!, matrix.find(cell => cell.variant.id === "nested-delegation")!]) {
    expect(canExecuteLiveCell(cell)).toBe(false);
    await expect(executor.executeBatch([{ cell, token: "fixture", checkpoint() {} }], new AbortController().signal)).rejects.toThrow("No live executor");
  }
  const serial = matrix.find(cell => canExecuteLiveCell(cell) && cell.lane === "serial")!;
  await expect(executor.executeBatch([serial, serial].map(cell => ({ cell, token: "fixture", checkpoint() {} })), new AbortController().signal)).rejects.toThrow("lanes or protocols");
});

test("a pre-native batch failure preserves its typed cause instead of reporting missing cell identities", () => {
  const batch = completedBatch(); batch.cells = [];
  batch.problem = problemFor(new DiagnosticError({ code: "tunnel_control_timeout", message: "Local tunnel health discovery timed out", origin: "tunnel-client", stage: "tunnel.control", signal: "SIGTERM" }));
  let failure: unknown;
  try { liveBatchOutcomes(cells, batch); } catch (error) { failure = error; }
  expect(problemFor(failure)).toEqual(batch.problem);
  delete batch.problem;
  expect(() => liveBatchOutcomes(cells, batch)).toThrow("exact owned cells");
});

test("archived history acceptance requires observed restoration of the prepared task", () => {
  const archivedCells = cells.map(cell => ({ ...cell, variant: { id: "archived-history", driver: "exec" as const } }));
  const batch = completedBatch();
  for (const item of batch.cells) {
    item.variant = "archived-history"; item.selections!.turns = 2;
    const terminal = item.result!.terminal;
    if (!("terminal" in terminal)) throw new Error("Fixture lacks exec evidence");
    item.result!.terminal = { ...terminal, preparation: { ...terminal }, archive: { threadId: terminal.threadId!, archived: true, restored: true } };
  }
  expect([...liveBatchOutcomes(archivedCells, batch).values()].every(outcome => outcome.status === "passed")).toBe(true);
  const terminal = batch.cells[0]!.result!.terminal;
  if (!("archive" in terminal) || !terminal.archive) throw new Error("Fixture lacks archive evidence");
  terminal.archive.threadId = "different-task";
  expect(() => liveBatchOutcomes(archivedCells, batch)).toThrow("observed archive and restoration");
});

test("phase acceptance rejects another task's observation and requires the steering artifact or stopped continuation", () => {
  const steeredCells = cells.map(cell => ({ ...cell, variant: { id: "steer-generation", driver: "app-server" as const } }));
  const batch = completedBatch();
  for (const item of batch.cells) {
    item.variant = "steer-generation"; item.selections!.turns = 2;
    item.result!.terminal = { status: "completed", threadId: item.result!.terminal.threadId, variant: item.variant, toolItems: 1, scenario: { variant: item.variant, turns: [{ id: "owned-turn", status: "completed", items: [] }], observation: { threadId: item.result!.terminal.threadId!, turnId: "owned-turn", phase: "generation" }, steeringWitness: "synthetic-witness" } };
    item.result!.oracle.artifacts.push({ path: "output/steering.txt", bytes: 18, sha256: "c".repeat(64) });
  }
  expect([...liveBatchOutcomes(steeredCells, batch).values()].every(outcome => outcome.status === "passed")).toBe(true);
  const first = batch.cells[0]!.result!.terminal;
  if (!("scenario" in first) || !first.scenario || !("observation" in first.scenario) || !first.scenario.observation) throw new Error("Fixture lacks scenario evidence");
  first.scenario.observation.threadId = "another-task";
  expect(() => liveBatchOutcomes(steeredCells, batch)).toThrow("exercised native task");
  first.scenario.observation.threadId = first.threadId!;
  batch.cells[0]!.result!.oracle.artifacts.pop();
  expect(() => liveBatchOutcomes(steeredCells, batch)).toThrow("committed correction");
  const stoppedCells = cells.map(cell => ({ ...cell, variant: { id: "stop-generation-continue", driver: "app-server" as const } }));
  for (const item of batch.cells) {
    item.variant = "stop-generation-continue"; item.selections!.turns = 2;
    item.result!.terminal = { status: "completed", threadId: item.result!.terminal.threadId, variant: item.variant, toolItems: 1, scenario: { variant: item.variant, turns: [{ id: "stopped-turn", status: "interrupted", items: [] }, { id: "continued-turn", status: "completed", items: [] }], observation: { threadId: item.result!.terminal.threadId!, turnId: "stopped-turn", phase: "generation" } } };
  }
  expect([...liveBatchOutcomes(stoppedCells, batch).values()].every(outcome => outcome.status === "passed")).toBe(true);
  const stopped = batch.cells[0]!.result!.terminal;
  if (!("scenario" in stopped) || !stopped.scenario) throw new Error("Fixture lacks stopped scenario");
  stopped.scenario.turns[0]!.status = "completed";
  expect(() => liveBatchOutcomes(stoppedCells, batch)).toThrow("acknowledged interruption");
});

test("a typed failed native terminal suspends admission even when capture is incomplete", () => {
  const batch = completedBatch();
  batch.incomplete = true;
  const item = batch.cells[0];
  item.passed = false; delete item.result;
  item.nativeFailure = { threadId: "limited-thread", turns: [{ id: "limited-turn", status: "failed", items: [], error: { codexErrorInfo: "rateLimitExceeded", message: "Synthetic limit" } }] };
  let failure: unknown;
  try { liveBatchOutcomes(cells, batch); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ name: "GoldenAdmissionSuspended", observation: { code: "rate_limit_exceeded", evidence: batch.evidence, threadId: "limited-thread", turnId: "limited-turn" } });
  item.nativeFailure.turns[0].error = { codexErrorInfo: "other", message: "rateLimitExceeded" };
  expect(() => liveBatchOutcomes(cells, batch)).toThrow("Incomplete live batch");
});

test("Unicode campaign coverage requires the exact committed UTF-8 witness", () => {
  const cell = { ...cells[0]!, variant: { id: "unicode", driver: "exec" as const } };
  expect(canExecuteLiveCell(cell)).toBe(true);
  const batch = completedBatch();
  batch.cells = [batch.cells[0]!];
  const item = batch.cells[0]!;
  item.variant = "unicode";
  item.result!.terminal.variant = "unicode";
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Unicode coverage lacks its independently validated UTF-8 artifact");
  item.result!.oracle.artifacts.push({ path: "output/unicode.txt", bytes: Buffer.byteLength(`${GOLDEN_UNICODE_WITNESS}\n`), sha256: createHash("sha256").update(`${GOLDEN_UNICODE_WITNESS}\n`).digest("hex") });
  expect(liveBatchOutcomes([cell], batch).get(cell.id)?.status).toBe("passed");
});

test("large-history campaign coverage requires preparation and its retained-context artifact", () => {
  const cell = { ...cells[0]!, variant: { id: "large-history", driver: "exec" as const } };
  expect(canExecuteLiveCell(cell)).toBe(true);
  const batch = completedBatch();
  batch.cells = [batch.cells[0]!];
  const item = batch.cells[0]!;
  item.variant = "large-history";
  item.result!.terminal.variant = "large-history";
  item.selections!.turns = 2;
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Large-history coverage lacks its retained-context artifact");
  Object.assign(item.result!.terminal, { historyWitnessSha256: "c".repeat(64) });
  item.result!.oracle.artifacts.push({ path: "output/history-witness.txt", bytes: 41, sha256: "c".repeat(64) });
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Resumed coverage requires completed preparation");
  Object.assign(item.result!.terminal, { preparation: { status: "completed", threadId: item.result!.terminal.threadId, terminal: { type: "turn.completed" }, observedItems: 1, exit: { code: 0, signal: null } } });
  expect(liveBatchOutcomes([cell], batch).get(cell.id)?.status).toBe("passed");
});

test("native compaction settlement accepts its full multipart preparation sequence only with matching turns", () => {
  const cell = { ...cells[0]!, variant: { id: "compaction", driver: "app-server" as const } };
  const batch = completedBatch(); batch.cells = [batch.cells[0]!];
  const item = batch.cells[0]!;
  item.variant = "compaction";
  item.selections!.turns = 4;
  const threadId = item.result!.terminal.threadId!;
  const turns = [0, 1, 2, 3].map(index => ({ id: `turn-${index}`, status: "completed" as const, items: [] }));
  item.result!.terminal = { status: "completed", threadId, variant: "compaction", toolItems: 1,
    scenario: { variant: "compaction", turns, compaction: { threadId, turnId: "compact-turn", itemId: "compact-item", turn: { id: "compact-turn", status: "completed", items: [] } },
      historyWitnessSha256: "c".repeat(64), multipartContext: { notes: 3_600, records: 3, sha256: "d".repeat(64) } } };
  item.result!.oracle.artifacts.push({ path: "output/history-witness.txt", bytes: 41, sha256: "c".repeat(64) });
  expect(liveBatchOutcomes([cell], batch).get(cell.id)?.status).toBe("passed");
  item.selections!.turns = 2;
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Compaction coverage");
  item.selections!.turns = 4;
  turns[3]!.id = turns[2]!.id;
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Compaction coverage");
  turns[3]!.id = "turn-3";
  const scenario = item.result!.terminal.scenario;
  if (!scenario || !("multipartContext" in scenario) || !scenario.multipartContext) throw new Error("Missing multipart fixture");
  scenario.multipartContext.records = 2;
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Compaction coverage");
});

test("native image campaign coverage requires the attached fixture and interpreted output", () => {
  const cell = { ...cells[0]!, variant: { id: "tool-image", driver: "exec" as const } };
  expect(canExecuteLiveCell(cell)).toBe(true);
  const batch = completedBatch();
  batch.cells = [batch.cells[0]!];
  const item = batch.cells[0]!;
  item.variant = "tool-image";
  item.result!.terminal.variant = "tool-image";
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Native image coverage lacks its exact attached fixture");
  Object.assign(item.result!.terminal, { attachedImageSha256: "c".repeat(64) });
  item.result!.oracle.artifacts.push({ path: "input/label.png", bytes: 100, sha256: "c".repeat(64) });
  expect(() => liveBatchOutcomes([cell], batch)).toThrow("Native image coverage lacks its exact attached fixture");
  item.result!.oracle.artifacts.push({ path: "output/attachments.json", bytes: 100, sha256: "d".repeat(64) });
  expect(liveBatchOutcomes([cell], batch).get(cell.id)?.status).toBe("passed");
});

test("verified provider admission survives incomplete exec evidence without inferring a limit from native prose", () => {
  const batch = completedBatch(), item = batch.cells[0]!;
  batch.incomplete = true; item.passed = false; delete item.result;
  item.nativeExecFailure = { phase: "preparation", outcome: { threadId: "00000000-0000-4000-8000-000000000001", status: "failed", terminal: { type: "turn.failed", error: { message: "rate limit exceeded" } }, observedItems: 0, exit: { code: 1, signal: null } } };
  expect(() => liveBatchOutcomes(cells, batch)).toThrow("Incomplete live batch");
  batch.admission = { code: "rate_limit_exceeded", reason: "Correlated provider evidence", evidence: "/fixture/provider-admission.json", threadId: item.nativeExecFailure.outcome.threadId, turnId: "00000000-0000-4000-8000-000000000010" };
  try { liveBatchOutcomes(cells, batch); throw new Error("Expected an admission constraint"); }
  catch (error) { expect(error).toMatchObject({ name: "GoldenAdmissionSuspended", observation: batch.admission }); }
});

test("model-switch settlement requires both native turns and their separate route evidence", () => {
  const switchedCells = cells.map(cell => ({ ...cell, variant: { id: "model-switch", driver: "app-server" as const } }));
  const batch = completedBatch();
  for (const [index, item] of batch.cells.entries()) {
    const from = cells[1 - index]!.route, to = cells[index]!.route;
    const turns = [0, 1].map(offset => ({ id: `00000000-0000-4000-8000-0000000000${index}${offset}`, status: "completed" as const, items: [] }));
    item.variant = "model-switch";
    item.result!.terminal = { status: "completed", threadId: item.result!.terminal.threadId, variant: item.variant, toolItems: 1, scenario: { variant: item.variant, turns, modelSwitch: { from: from.slug, to: to.slug } } };
    item.selections = { ...item.selections!, turns: 2, sequence: [from, to].map((route, offset) => ({ ...item.selections!, turnId: turns[offset]!.id, routeSlug: route.slug, observedModel: route.backendModel, observedEffort: route.adapterEffort })) };
  }
  expect([...liveBatchOutcomes(switchedCells, batch).values()].every(outcome => outcome.status === "passed")).toBeTrue();
  const selection = batch.cells[0]!.selections!;
  if (!("sequence" in selection)) throw new Error("Fixture lacks per-turn selection evidence");
  const turnId = selection.sequence[0]!.turnId;
  selection.sequence[0]!.turnId = selection.sequence[1]!.turnId;
  expect(() => liveBatchOutcomes(switchedCells, batch)).toThrow("matching route selections");
  selection.sequence[0]!.turnId = turnId;
  selection.sequence[0]!.passed = false;
  expect(() => liveBatchOutcomes(switchedCells, batch)).toThrow("matching route selections");
  selection.sequence[0]!.passed = true;
  batch.cells[0]!.selections = { passed: true, failures: [], turns: 2, eventIds: selection.eventIds, observedModel: selection.observedModel, observedEffort: selection.observedEffort };
  expect(() => liveBatchOutcomes(switchedCells, batch)).toThrow("matching route selections");
});

test("TUI settlement requires native Plan items and matching separate title acceptance", () => {
  const tuiCells = cells.map(cell => ({ ...cell, variant: { id: "plan-tui-execute", driver: "tui" as const } }));
  const batch = completedBatch();
  for (const [index, item] of batch.cells.entries()) {
    item.variant = "plan-tui-execute"; item.selections!.turns = 2;
    const turns = [{ id: crypto.randomUUID(), status: "completed" as const, items: [{ type: "plan", text: "Synthetic plan" }] }, { id: crypto.randomUUID(), status: "completed" as const, items: [] }];
    const title = { threadId: crypto.randomUUID(), active: true, idle: true };
    item.result!.terminal = { status: "completed", threadId: item.result!.terminal.threadId!, variant: "plan-tui-execute", toolItems: 1, scenario: { variant: "plan-tui-execute", turns, planHashes: nativePlanHashes(turns[0]!), titleTasks: [title] } };
    item.titles = { passed: true, failures: [], titles: [{ threadId: title.threadId, passed: true, failures: [], requests: 1, browserTurns: 1, turnIds: [crypto.randomUUID()], traceIds: [String(index + 3).repeat(32)], selections: { ...item.selections!, turns: 1 } }] };
  }
  expect([...liveBatchOutcomes(tuiCells, batch).values()].every(outcome => outcome.status === "passed")).toBeTrue();
  const titleEvidence = batch.cells[0]!.titles!;
  delete batch.cells[0]!.titles;
  expect(() => liveBatchOutcomes(tuiCells, batch)).toThrow("TUI acceptance");
  batch.cells[0]!.titles = titleEvidence;
  const titleId = titleEvidence.titles[0]!.threadId;
  titleEvidence.titles[0]!.threadId = crypto.randomUUID();
  expect(() => liveBatchOutcomes(tuiCells, batch)).toThrow("TUI acceptance");
  titleEvidence.titles[0]!.threadId = titleId;
  const terminal = batch.cells[0]!.result!.terminal;
  if (!("scenario" in terminal) || !terminal.scenario || !("titleTasks" in terminal.scenario)) throw new Error("Missing TUI fixture");
  terminal.scenario.turns[0]!.items = [];
  expect(() => liveBatchOutcomes(tuiCells, batch)).toThrow("TUI acceptance");
});
