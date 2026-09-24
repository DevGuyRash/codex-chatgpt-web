import { isProGeneration } from "../../src/campaign-policy";
import type { GoldenCell } from "./catalog";
import { finiteNativeScenarios, type FiniteNativeScenario } from "./native-scenarios";
import { runLiveBatch } from "./live-batch";
import type { GoldenOutcome } from "./queue";
import type { GoldenAttempt } from "./runner";
import { goldenScenarioTerminations } from "./observations";
import { GoldenAdmissionSuspended, nativeAdmissionObservation } from "./admission";
import { nativePlanHashes } from "./app-server";
import { GOLDEN_UNICODE_WITNESS } from "./workloads";
import { createHash } from "node:crypto";
import { DiagnosticError } from "../../src/diagnostics/problems";

type LiveBatchResult = Awaited<ReturnType<typeof runLiveBatch>>;
type LiveCellResult = LiveBatchResult["cells"][number];
type LiveBatchSettlement = Pick<LiveBatchResult, "cells" | "protocol" | "incomplete" | "evidenceExport" | "problem" | "bundleSha256" | "evidence" | "admission">;

/** Availability is separate from applicability: unavailable coordinators stay pending in the full matrix. */
export function canExecuteLiveCell(cell: GoldenCell): boolean {
  return !cell.exclusion && !isProGeneration(cell.route) && cell.route.interactionMode === "automatic"
    && cell.workload < 5 && Object.hasOwn(finiteNativeScenarios, cell.variant.id);
}

function finiteCellOutcome(cell: GoldenCell, result: LiveCellResult, batch: LiveBatchSettlement): GoldenOutcome {
  if (!canExecuteLiveCell(cell) || result.id !== cell.id || result.routeSlug !== cell.route.slug || result.workload !== cell.workload || result.variant !== cell.variant.id || batch.protocol !== cell.protocol) throw new Error("Live evidence does not match the exact claimed campaign cell");
  const proof = result.result;
  // A stopped process or a completed export cannot establish an unobserved native terminal.
  if (!proof || proof.terminal.status !== "completed" || !proof.terminal.threadId) throw new Error("Native terminal evidence requires reconciliation before campaign settlement");
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
  if (["resumed", "archived-history"].includes(cell.variant.id) && (!("preparation" in proof.terminal) || proof.terminal.preparation?.status !== "completed" || proof.terminal.preparation.threadId !== proof.terminal.threadId)) throw new Error("Resumed coverage requires completed preparation in the same native task");
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
  if (!result.cells.length && result.problem) throw new DiagnosticError(result.problem);
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
export function liveCampaignExecutor(options: Pick<Parameters<typeof runLiveBatch>[0], "root" | "sourceHome" | "executable" | "turnTimeoutMs">) {
  return {
    canExecute: canExecuteLiveCell,
    async executeBatch(attempts: readonly GoldenAttempt[], signal: AbortSignal): Promise<ReadonlyMap<string, GoldenOutcome>> {
      if (!attempts.length || attempts.length > 2 || attempts.some(attempt => !canExecuteLiveCell(attempt.cell))) throw new Error("No live executor is available for this campaign batch");
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
