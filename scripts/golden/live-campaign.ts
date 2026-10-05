import { isProGeneration } from "../../src/campaign-policy";
import { CHATGPT_WEB_LUNA_BACKEND_MODEL } from "../../src/chatgpt-web-models";
import type { GoldenCell } from "./catalog";
import { finiteNativeScenarios, type FiniteNativeScenario } from "./native-scenarios";
import { runLiveBatch } from "./live-batch";
import type { GoldenOutcome } from "./queue";
import type { GoldenAttempt } from "./runner";
import { goldenScenarioTerminations } from "./observations";
import { GoldenAdmissionSuspended, nativeAdmissionObservation } from "./admission";
import { nativePlanHashes, type NativeCompaction } from "./app-server";
import { GOLDEN_UNICODE_WITNESS, GOLDEN_RECOVERABLE_FAILURE_FILE, GOLDEN_LARGE_TOOL_RESULT_FILE } from "./workloads";
import { createHash } from "node:crypto";
import { DiagnosticError } from "../../src/diagnostics/problems";

type LiveBatchResult = Awaited<ReturnType<typeof runLiveBatch>>;
type LiveCellResult = LiveBatchResult["cells"][number];
type LiveBatchSettlement = Pick<LiveBatchResult, "cells" | "protocol" | "incomplete" | "evidenceExport" | "problem" | "bundleSha256" | "evidence" | "admission"> & { generationAdmitted?: boolean };
const multipartContext = (value: unknown): value is { records: number; notes: number; sha256: string } =>
  value !== null && typeof value === "object" && "records" in value && typeof value.records === "number"
  && "notes" in value && typeof value.notes === "number" && "sha256" in value && typeof value.sha256 === "string";

/** Availability is separate from applicability: unavailable coordinators stay pending in the full matrix. */
export function canExecuteLiveCell(cell: GoldenCell): boolean {
  return !cell.exclusion && !isProGeneration(cell.route) && cell.route.interactionMode === "automatic"
    && !(cell.variant.id === "retained-conversation-change" && cell.route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL)
    && cell.workload < 5 && Object.hasOwn(finiteNativeScenarios, cell.variant.id);
}

/** Pending matrix cells may be settled from retained evidence, but only serial work is admitted until implicit child generations can be counted. */
export function canAdmitLiveCell(cell: GoldenCell): boolean {
  return canExecuteLiveCell(cell) && cell.lane === "serial" && cell.variant.id !== "plan-tui-execute";
}

function finiteCellOutcome(cell: GoldenCell, result: LiveCellResult, batch: LiveBatchSettlement): GoldenOutcome {
  if (!canExecuteLiveCell(cell) || result.id !== cell.id || result.routeSlug !== cell.route.slug || result.workload !== cell.workload || result.variant !== cell.variant.id || batch.protocol !== cell.protocol) throw new Error("Live evidence does not match the exact claimed campaign cell");
  const proof = result.result;
  // A stopped process or a completed export cannot establish an unobserved native terminal.
  if (!proof || proof.terminal.status !== "completed" || !proof.terminal.threadId) {
    const scenarioTerminal = result.nativeFailure?.turns.at(-1);
    const execTerminal = result.nativeExecFailure?.outcome;
    const terminal = scenarioTerminal && ["completed", "failed", "interrupted"].includes(scenarioTerminal.status)
      && result.nativeFailure?.threadId ? scenarioTerminal
      : execTerminal && ["failed", "interrupted"].includes(execTerminal.status)
        && execTerminal.threadId ? execTerminal : undefined;
    if (terminal && result.error && typeof batch.evidence === "string" && batch.evidence.length > 0) {
      return { status: "blocked", reason: `The exact native task ended ${terminal.status} with ${result.error.code}; inspect its retained submission and tool effects before any distinct attempt`, evidence: batch.evidence };
    }
    throw new Error("Native terminal evidence requires reconciliation before campaign settlement");
  }
  if (!result.passed) return { status: "failed", reason: result.error?.message ?? "The completed native task failed independent workload, commit, selection or receipt acceptance", evidence: batch.evidence };
  if (result.error || !proof.terminal.toolItems || !proof.oracle.passed || !proof.commit.passed || !result.selections?.passed || !result.receipts?.passed || !result.receipts.calls
    || !Number.isSafeInteger(result.receipts.returned) || result.receipts.returned < 0
    || !Number.isSafeInteger(result.receipts.intentionalTerminations) || result.receipts.intentionalTerminations < 0
    || result.receipts.returned + result.receipts.intentionalTerminations !== result.receipts.calls
    || result.selections.turns < finiteNativeScenarios[cell.variant.id as FiniteNativeScenario]
    || result.selections.observedModel !== cell.route.backendModel || result.selections.observedEffort !== cell.route.adapterEffort) throw new Error("A positive live result lacks required independent evidence");
  if (result.receipts.intentionalTerminations && !goldenScenarioTerminations(cell.variant.id, proof.terminal).length) throw new Error("Tool termination lacks matching native scenario evidence");
  if (cell.variant.id === "formats" && ["input/dispatch.pdf", "input/dispatch.docx", "input/dispatch.xlsx", "input/label.png", "output/attachments.json", "output/teams.csv"].some(path => !proof.oracle.artifacts.some(artifact => artifact.path === path && artifact.bytes > 0 && /^[a-f\d]{64}$/.test(artifact.sha256)))) throw new Error("Format coverage lacks validated document, image and output artifacts");
  if (cell.variant.id === "unicode") {
    const expectedSha256 = createHash("sha256").update(`${GOLDEN_UNICODE_WITNESS}\n`).digest("hex");
    if (!proof.oracle.artifacts.some(artifact => artifact.path === "output/unicode.txt" && artifact.sha256 === expectedSha256)) throw new Error("Unicode coverage lacks its independently validated UTF-8 artifact");
  }
  if (cell.variant.id === "tool-image") {
    const attachedSha256 = "attachedImageSha256" in proof.terminal ? proof.terminal.attachedImageSha256 : undefined;
    if (typeof attachedSha256 !== "string" || !/^[a-f\d]{64}$/.test(attachedSha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "input/label.png" && artifact.sha256 === attachedSha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/attachments.json" && artifact.bytes > 0)) {
      throw new Error("Native image coverage lacks its exact attached fixture and independently validated result");
    }
  }
  if (cell.variant.id === "tool-failure") {
    const failure = "failureWitness" in proof.terminal ? proof.terminal.failureWitness : undefined;
    if (!failure || failure.count !== 1 || failure.expectedExitCode !== 17
      || !proof.oracle.artifacts.some(artifact => artifact.path === GOLDEN_RECOVERABLE_FAILURE_FILE && artifact.bytes > 0)) {
      throw new Error("Recoverable tool failure requires one actual failed native command and its unchanged runner-owned fixture");
    }
  }
  if (cell.variant.id === "large-tool-result") {
    const witness = "largeResultWitness" in proof.terminal ? proof.terminal.largeResultWitness : undefined;
    const digestArtifact = witness && typeof witness.sha256 === "string"
      ? createHash("sha256").update(`${witness.sha256}\n`).digest("hex") : undefined;
    if (!witness || witness.invocations !== 1 || witness.count !== 1 || witness.bytes < 32_000
      || !/^[a-f\d]{64}$/.test(witness.sha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === GOLDEN_LARGE_TOOL_RESULT_FILE && artifact.bytes > 0)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/large-tool-result.sha256" && artifact.sha256 === digestArtifact)) {
      throw new Error("Large tool result coverage requires one complete native command result and its independently validated committed digest");
    }
  }
  if (cell.variant.id === "large-history") {
    const expectedSha256 = "historyWitnessSha256" in proof.terminal ? proof.terminal.historyWitnessSha256 : undefined;
    if (typeof expectedSha256 !== "string" || !/^[a-f\d]{64}$/.test(expectedSha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/history-witness.txt" && artifact.sha256 === expectedSha256)) {
      throw new Error("Large-history coverage lacks its retained-context artifact");
    }
  }
  if (cell.variant.id === "compaction") {
    const scenario = "scenario" in proof.terminal ? proof.terminal.scenario : undefined;
    const compact = scenario && "compaction" in scenario ? scenario.compaction as NativeCompaction : undefined;
    const witnessSha256 = scenario && "historyWitnessSha256" in scenario ? scenario.historyWitnessSha256 : undefined;
    const rawMultipart = scenario && "multipartContext" in scenario ? scenario.multipartContext : undefined;
    const multipart = multipartContext(rawMultipart) ? rawMultipart : undefined;
    const expectedTurns = multipart ? multipart.records + 1 : 2;
    if (!scenario || !compact || compact.threadId !== proof.terminal.threadId || compact.turn.status !== "completed" || compact.turn.id !== compact.turnId
      || !compact.itemId || rawMultipart !== undefined && (!multipart || multipart.records !== 3 || multipart.notes !== 3_600 || !/^[a-f\d]{64}$/.test(multipart.sha256))
      || scenario.turns.length !== expectedTurns || result.selections.turns < expectedTurns
      || new Set(scenario.turns.map(turn => turn.id)).size !== expectedTurns
      || scenario.turns.some(turn => turn.status !== "completed" || turn.id === compact.turnId)
      || typeof witnessSha256 !== "string" || !/^[a-f\d]{64}$/.test(witnessSha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/history-witness.txt" && artifact.sha256 === witnessSha256)) {
      throw new Error("Compaction coverage requires the exact native item and terminal between completed same-task turns, plus a committed retained-context witness");
    }
  }
  if (["resumed", "archived-history", "large-history", "retained-conversation-change"].includes(cell.variant.id) && (!("preparation" in proof.terminal) || proof.terminal.preparation?.status !== "completed" || proof.terminal.preparation.threadId !== proof.terminal.threadId)) throw new Error("Resumed coverage requires completed preparation in the same native task");
  if (cell.variant.id === "retained-conversation-change") {
    const historySha256 = "historyWitnessSha256" in proof.terminal ? proof.terminal.historyWitnessSha256 : undefined;
    const revisionSha256 = "revisionWitnessSha256" in proof.terminal ? proof.terminal.revisionWitnessSha256 : undefined;
    if (typeof historySha256 !== "string" || !/^[a-f\d]{64}$/.test(historySha256)
      || typeof revisionSha256 !== "string" || !/^[a-f\d]{64}$/.test(revisionSha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/history-witness.txt" && artifact.sha256 === historySha256)
      || !proof.oracle.artifacts.some(artifact => artifact.path === "output/revision.txt" && artifact.sha256 === revisionSha256)
      || !result.retainedTab?.passed || result.retainedTab.threadId !== proof.terminal.threadId
      || result.retainedTab.turnIds.length !== 2 || new Set(result.retainedTab.turnIds).size !== 2
      || result.retainedTab.turnIds.some(turnId => !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(turnId))
      || !result.retainedTab.tabId) {
      throw new Error("Retained conversation change requires a completed same-task follow-up, both committed witnesses and exact launcher tab reuse");
    }
  }
  if (cell.variant.id === "archived-history" && (!("archive" in proof.terminal) || proof.terminal.archive?.threadId !== proof.terminal.threadId || !proof.terminal.archive.archived || !proof.terminal.archive.restored)) throw new Error("Archived coverage requires observed archive and restoration of the same native task");
  if (["continued", "plan-revise-execute", "plan-tui-execute"].includes(cell.variant.id) && (!("scenario" in proof.terminal) || proof.terminal.scenario?.turns.length !== finiteNativeScenarios[cell.variant.id as FiniteNativeScenario] || proof.terminal.scenario.turns.some(turn => turn.status !== "completed"))) throw new Error("Sequential scenario coverage requires every native turn to complete");
  if (cell.variant.id === "plan-tui-execute") {
    const scenario = "scenario" in proof.terminal ? proof.terminal.scenario : undefined;
    if (!scenario || !("titleTasks" in scenario) || !scenario.planHashes.length || scenario.planHashes.some(hash => !/^[a-f\d]{64}$/.test(hash))
      || new Set(scenario.turns.map(turn => turn.id)).size !== 2 || JSON.stringify(nativePlanHashes(scenario.turns[0]!)) !== JSON.stringify(scenario.planHashes)
      || !result.titles?.passed || result.titles.failures.length || result.titles.titles.length !== scenario.titleTasks.length || !scenario.titleTasks.length
      || new Set(scenario.titleTasks.map(title => title.threadId)).size !== scenario.titleTasks.length
      || scenario.titleTasks.some(title => !title.active || !title.idle || title.threadId === proof.terminal.threadId || !result.titles!.titles.some(observed => observed.threadId === title.threadId && observed.passed && !observed.failures.length && observed.requests > 0 && observed.browserTurns > 0 && observed.turnIds.length === 1 && observed.selections.passed && observed.selections.observedModel === cell.route.backendModel && observed.selections.observedEffort === cell.route.adapterEffort))) throw new Error("TUI acceptance requires native Plan evidence and independently settled, admitted title work");
  }
  if (cell.variant.id === "model-switch") {
    const scenario = "scenario" in proof.terminal ? proof.terminal.scenario : undefined;
    const selection = result.selections;
    const sequence = selection && "sequence" in selection ? selection.sequence : undefined;
    if (!scenario || !("modelSwitch" in scenario) || !scenario.modelSwitch || scenario.modelSwitch.from === scenario.modelSwitch.to || scenario.modelSwitch.to !== cell.route.slug
      || scenario.turns.length !== 2 || scenario.turns.some(turn => turn.status !== "completed") || scenario.turns[0]!.id === scenario.turns[1]!.id
      || !sequence || sequence.length !== 2 || sequence.some((entry, index) => !entry.passed || entry.turnId !== scenario.turns[index]!.id || entry.routeSlug !== (index === 0 ? scenario.modelSwitch!.from : scenario.modelSwitch!.to))) throw new Error("Model-switch coverage requires distinct completed native turns with matching route selections in the same task");
  }
  const phaseMatch = /^(steer|stop)-(reasoning|generation|tools)/.exec(cell.variant.id), planInterrupt = cell.variant.id === "plan-stream-interrupt";
  if (phaseMatch || planInterrupt) {
    const scenario = "scenario" in proof.terminal ? proof.terminal.scenario : undefined;
    const observation = scenario && "observation" in scenario ? scenario.observation : undefined;
    if (!scenario || !observation || observation.threadId !== proof.terminal.threadId || observation.turnId !== scenario.turns[0]?.id || observation.phase !== (planInterrupt ? "generation" : phaseMatch![2])) throw new Error("Scenario phase evidence must identify the exercised native task and turn");
    const statuses = scenario.turns.map(turn => turn.status);
    if (phaseMatch?.[1] === "steer") {
      if (statuses.length !== 1 || statuses[0] !== "completed" || !("steeringWitness" in scenario) || !scenario.steeringWitness || !proof.oracle.artifacts.some(artifact => artifact.path === "output/steering.txt")) throw new Error("Steering acceptance requires a completed turn and its committed correction artifact");
    } else if (statuses.length !== 2 || statuses[0] !== "interrupted" || statuses[1] !== "completed") throw new Error("Stop acceptance requires acknowledged interruption before its completed continuation");
  }
  return { status: "passed", reason: "Completed native task, validated committed artifacts, observed browser selection and attributable tool outcomes in a complete diagnostic bundle", evidence: batch.evidence,
    verification: { checks: ["artifacts", "commit", "settlement", "diagnostics", "no-duplicate-effects", `variant:${cell.variant.id}`], observedModel: result.selections.observedModel, observedEffort: result.selections.observedEffort, activeProgressMs: 0, bundleSha256: batch.bundleSha256 },
  };
}

/** Convert only settled producer/export results; any uncertainty preserves all batch claims. */
export function liveBatchOutcomes(cells: readonly GoldenCell[], result: LiveBatchSettlement): ReadonlyMap<string, GoldenOutcome> {
  if (!result.cells.length && result.problem) {
    if (result.admission) throw new GoldenAdmissionSuspended(result.admission);
    if (result.generationAdmitted === false && !result.incomplete && result.evidenceExport === "complete"
      && typeof result.evidence === "string" && result.evidence.length > 0 && /^[a-f\d]{64}$/.test(result.bundleSha256)
      && cells.length >= 1 && cells.length <= 2 && new Set(cells.map(cell => cell.id)).size === cells.length
      && cells.every(cell => canExecuteLiveCell(cell) && cell.protocol === result.protocol)) {
      return new Map(cells.map(cell => [cell.id, {
        status: "failed" as const,
        reason: `The owned batch failed before any native generation was admitted (${result.problem!.code}); inspect its complete diagnostic export before a distinct attempt`,
        evidence: result.evidence,
      }]));
    }
    throw new DiagnosticError(result.problem);
  }
  if (result.cells.length !== cells.length || new Set(result.cells.map(cell => cell.id)).size !== cells.length || result.cells.some(item => !cells.some(cell => cell.id === item.id))) throw new Error("Live batch results do not match their exact owned cells");
  for (const item of result.cells) {
    const cell = cells.find(cell => cell.id === item.id)!;
    if (item.routeSlug !== cell.route.slug || item.workload !== cell.workload || item.variant !== cell.variant.id || result.protocol !== cell.protocol) throw new Error("Live evidence does not match the exact claimed campaign cell");
    const observation = nativeAdmissionObservation(item.nativeFailure, result.evidence);
    if (observation) throw new GoldenAdmissionSuspended(observation);
  }
  if (result.admission) throw new GoldenAdmissionSuspended(result.admission);
  if (result.incomplete || result.evidenceExport !== "complete" || result.problem || !/^[a-f\d]{64}$/.test(result.bundleSha256)) throw new Error("Incomplete live batch evidence requires reconciliation");
  const threads = result.cells.flatMap(item => item.result?.terminal.threadId ? [item.result.terminal.threadId] : []);
  if (new Set(threads).size !== threads.length || new Set(result.cells.map(item => item.traceId)).size !== cells.length || new Set(result.cells.map(item => item.work)).size !== cells.length) throw new Error("Distinct campaign cells cannot accept shared producer identities or artifact directories");
  return new Map(cells.map(cell => [cell.id, finiteCellOutcome(cell, result.cells.find(item => item.id === cell.id)!, result)]));
}

/** Adapter between queue ownership and the live owner; neither layer may infer the other's settlement. */
export function liveCampaignExecutor(options: Pick<Parameters<typeof runLiveBatch>[0], "root" | "sourceHome" | "executable" | "turnTimeoutMs" | "hardDeadlineAt">) {
  return {
    canExecute: canAdmitLiveCell,
    async executeBatch(attempts: readonly GoldenAttempt[], signal: AbortSignal): Promise<ReadonlyMap<string, GoldenOutcome>> {
      if (attempts.length !== 1 || attempts.some(attempt => !canAdmitLiveCell(attempt.cell))) throw new Error("No serial live executor is available for this campaign batch");
      const first = attempts[0]!.cell;
      if (attempts.some(attempt => attempt.cell.protocol !== first.protocol || attempt.cell.lane !== first.lane) || (first.lane === "serial" && attempts.length !== 1)) throw new Error("A live batch cannot mix campaign lanes or protocols");
      const result = await runLiveBatch({ ...options, signal, protocol: first.protocol,
        onPrepared: identity => { for (const attempt of attempts) attempt.checkpoint({ traceIds: [identity.traceId], campaignId: identity.campaignId, evidenceRoot: identity.work }); },
        cells: attempts.map(attempt => ({
        id: attempt.cell.id, routeSlug: attempt.cell.route.slug, workload: attempt.cell.workload, variant: attempt.cell.variant.id as FiniteNativeScenario,
        checkpoint: identity => attempt.checkpoint({ traceIds: [identity.traceId], campaignId: identity.campaignId, evidenceRoot: identity.work, nativePid: identity.native.pid, nativeStart: identity.native.start, nativeExecutable: identity.native.executable,
          ...(identity.threadId ? { threadId: identity.threadId } : {}), ...(identity.turnId ? { turnId: identity.turnId } : {}),
        }),
      })) });
      return liveBatchOutcomes(attempts.map(attempt => attempt.cell), result);
    },
  };
}
