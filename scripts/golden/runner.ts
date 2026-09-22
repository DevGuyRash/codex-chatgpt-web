import { setTimeout as wait } from "node:timers/promises";
import type { Protocol, GoldenCell } from "./catalog";
import { GoldenQueue, type GoldenCheckpoint, type GoldenOutcome } from "./queue";
import { GoldenAdmissionSuspended } from "./admission";

export interface GoldenAttempt {
  cell: GoldenCell; token: string;
  checkpoint(input: GoldenCheckpoint): void;
}
type ExecutionOwner = {
  execute(attempt: GoldenAttempt, signal: AbortSignal): Promise<GoldenOutcome>;
} | {
  /** Return only after shared producers, runtime cleanup and evidence export have settled. */
  executeBatch(attempts: readonly GoldenAttempt[], signal: AbortSignal): Promise<ReadonlyMap<string, GoldenOutcome>>;
};

/** Native/browser execution stays with the scenario owner; this loop owns scheduling only. */
export async function runGoldenCampaign(options: {
  queue: GoldenQueue;
  signal: AbortSignal;
  /** Executor availability never changes the declared matrix or marks missing coverage complete. */
  canExecute?(cell: GoldenCell): boolean;
  configure(protocol: Protocol): Promise<void>;
  admission(): Promise<void>;
  onBackoff(observation: { until: number; reason: string }): void | Promise<void>;
  onSettled(cell: GoldenCell, outcome: GoldenOutcome): void | Promise<void>;
} & ExecutionOwner) {
  const { queue, signal } = options;
  const runnerToken = queue.acquireRunner();
  try {
  // A new process cannot infer whether an earlier submitted turn finished from a dead PID.
  if (queue.running().length) return { status: "reconciliation-required" as const, running: queue.running(), summary: queue.summary() };
  let configured: Protocol | undefined;
  while (!signal.aborted) {
    if (queue.summary().admissionHold) return { status: "admission-suspended" as const, summary: queue.summary() };
    const schedule = queue.nextSchedule(options.canExecute);
    if (!schedule) return { status: queue.nextSchedule() ? "executor-coverage-pending" as const : "automatic-lane-settled" as const, summary: queue.summary() };
    const backoff = queue.summary().backoff;
    if (backoff && backoff.until > Date.now()) {
      await options.onBackoff(backoff);
      try { await wait(Math.min(60_000, backoff.until - Date.now()), undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
      continue;
    }
    if (configured !== schedule.protocol) {
      await options.configure(schedule.protocol);
      configured = schedule.protocol;
    }
    await options.admission();
    if (signal.aborted) break;
    const claims: { cell: GoldenCell; token: string }[] = [];
    for (let index = 0; index < (schedule.lane === "serial" ? 1 : 2); index++) {
      const claim = queue.claim({ ...schedule, runnerToken, eligible: options.canExecute });
      if (claim) claims.push(claim);
    }
    if (!claims.length) {
      // Another owner or a new backoff may have changed admission after inspection.
      if (queue.running().length) return { status: "reconciliation-required" as const, running: queue.running(), summary: queue.summary() };
      continue;
    }
    const attempts: GoldenAttempt[] = claims.map(claim => ({ ...claim, checkpoint: input => queue.checkpoint(claim.cell.id, claim.token, input) }));
    const settle = async (attempt: GoldenAttempt, outcome: GoldenOutcome) => {
      queue.settle(attempt.cell.id, attempt.token, outcome);
      await options.onSettled(attempt.cell, outcome);
    };
    const results = "executeBatch" in options
      ? await Promise.allSettled([(async () => {
        const outcomes = await options.executeBatch(attempts, signal);
        if (outcomes.size !== attempts.length || attempts.some(attempt => !outcomes.has(attempt.cell.id))) throw new Error("Batch results do not match their exact owned cells");
        for (const attempt of attempts) await settle(attempt, outcomes.get(attempt.cell.id)!);
      })()])
      : await Promise.allSettled(attempts.map(async attempt => settle(attempt, await options.execute(attempt, signal))));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    for (const result of failed) if (result.reason instanceof GoldenAdmissionSuspended) queue.suspendAdmission(result.reason.observation);
    // Wait for the other owned executor to finish before surfacing failure. An exception cannot
    // establish settlement, so its durable claim remains running for evidence-based recovery.
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Golden execution requires reconciliation; unresolved claims were preserved");
  }
  return { status: "stopped" as const, summary: queue.summary() };
  } finally { queue.releaseRunner(runnerToken); }
}
