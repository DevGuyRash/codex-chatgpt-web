import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoldenAdmissionSuspended } from "../scripts/golden/admission";
import { GoldenQueue } from "../scripts/golden/queue";
import { runGoldenCampaign, type GoldenAttempt } from "../scripts/golden/runner";
import type { CapabilitySnapshot } from "../scripts/golden/catalog";
import { buildGoldenMatrix } from "../scripts/golden/catalog";
import { Database } from "bun:sqlite";
import { setTimeout as wait } from "node:timers/promises";
const snapshot: CapabilitySnapshot = { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", capabilities: { solAvailable: false, proAvailable: false }, nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64) };

test("the scheduler leaves unimplemented scenarios pending while executing an admitted boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-coverage-"));
  const queue = new GoldenQueue(join(root, "queue.sqlite"), { snapshot, implementationSha256: "b".repeat(64) });
  const selected = buildGoldenMatrix(snapshot).find(cell => !cell.exclusion && cell.variant.id === "plan-revise-execute" && cell.workload === 1 && cell.lane === "concurrent" && cell.protocol === "native")!;
  const before = queue.summary().counts.pending;
  let executions = 0;
  try {
    const result = await runGoldenCampaign({ queue, signal: new AbortController().signal, canExecute: cell => cell.id === selected.id,
      configure: async protocol => { expect(protocol).toBe("native"); }, admission: async () => {}, onBackoff: () => {}, onSettled: () => {},
      executeBatch: async attempts => {
        expect(attempts.map(attempt => attempt.cell.id)).toEqual([selected.id]); executions++;
        return new Map([[selected.id, { status: "failed" as const, reason: "Independent fixture rejection" }]]);
      },
    });
    expect(result.status).toBe("executor-coverage-pending");
    expect(executions).toBe(1);
    expect(queue.summary().counts.pending).toBe(before - 1);
    expect(queue.running()).toHaveLength(0);
    expect(queue.nextSchedule()).toBeDefined();
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the continuous runner checkpoints serial attempts and does not replay uncertain work after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-runner-"));
  const queue = new GoldenQueue(join(root, "queue.sqlite"), { snapshot, implementationSha256: "b".repeat(64) });
  const controller = new AbortController();
  let executed = 0, configured = 0;
  const options = { queue, signal: controller.signal, configure: async () => { configured++; }, admission: async () => {}, onBackoff: () => {}, onSettled: () => {}, execute: async (attempt: GoldenAttempt) => {
    expect(attempt.cell.lane).toBe("serial");
    attempt.checkpoint({ threadId: "observed-thread" });
    if (++executed === 2) throw new Error("Observation ended without terminal evidence");
    return { status: "failed" as const, reason: "Controlled artifact failure", evidence: "fixture.zip" };
  } };
  try {
    await expect(runGoldenCampaign(options)).rejects.toThrow("reconciliation");
    expect(executed).toBe(2);
    expect(configured).toBe(1);
    expect(queue.running()).toHaveLength(1);
    expect(queue.running()[0]!.checkpoint.threadId).toBe("observed-thread");
    expect((await runGoldenCampaign(options)).status).toBe("reconciliation-required");
    expect(executed).toBe(2);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each([false, true])("paired cells wait for their shared runtime cleanup (failure=%s)", async cleanupFails => {
  const root = mkdtempSync(join(tmpdir(), "golden-batch-")), path = join(root, "queue.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  const fixture = new Database(path);
  const ids = buildGoldenMatrix(snapshot).filter(cell => !cell.exclusion && cell.lane === "concurrent" && cell.protocol === "native" && cell.variant.driver !== "assisted").slice(0, 2).map(cell => cell.id);
  fixture.query("UPDATE cells SET status='failed' WHERE id NOT IN (?,?) AND status='pending'").run(ids[0]!, ids[1]!); fixture.close();
  let called = false, cleanupSettled = false, settled = 0;
  const options = { queue, signal: new AbortController().signal, configure: async () => {}, admission: async () => {}, onBackoff: () => {},
    onSettled: () => { expect(cleanupSettled).toBe(true); settled++; },
    executeBatch: async (attempts: readonly GoldenAttempt[]) => {
      called = true;
      expect(attempts.map(attempt => attempt.cell.id)).toEqual(ids);
      expect(queue.running()).toHaveLength(2);
      for (const attempt of attempts) attempt.checkpoint({ threadId: `owned-${attempt.cell.id}` });
      await wait(5);
      if (cleanupFails) throw new Error("Shared runtime did not settle");
      cleanupSettled = true;
      return new Map(attempts.map(attempt => [attempt.cell.id, { status: "failed" as const, reason: "Independent synthetic artifact rejection" }]));
    },
  };
  try {
    if (cleanupFails) {
      await expect(runGoldenCampaign(options)).rejects.toThrow("reconciliation");
      expect(queue.running()).toHaveLength(2);
      expect(settled).toBe(0);
      expect((await runGoldenCampaign(options)).status).toBe("reconciliation-required");
    } else {
      expect((await runGoldenCampaign(options)).status).toBe("automatic-lane-settled");
      expect(settled).toBe(2); expect(queue.running()).toHaveLength(0);
    }
    expect(called).toBe(true);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent attempts share one configuration owner and settle within the two-slot lane", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-concurrent-")), path = join(root, "queue.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  const fixture = new Database(path);
  const ids = buildGoldenMatrix(snapshot).filter(cell => !cell.exclusion && cell.lane === "concurrent" && cell.protocol === "native" && cell.variant.driver !== "assisted").slice(0, 2).map(cell => cell.id);
  fixture.query("UPDATE cells SET status='failed' WHERE id NOT IN (?,?) AND status='pending'").run(ids[0]!, ids[1]!); fixture.close();
  const controller = new AbortController(); let active = 0, peak = 0, configured = 0, settled = 0;
  const options = { queue, signal: controller.signal, configure: async () => {
    configured++;
    await expect(runGoldenCampaign(options)).rejects.toThrow("live scheduler");
    expect(() => queue.claim({ lane: "concurrent", protocol: "native" })).toThrow("owns admission");
  }, admission: async () => {}, onBackoff: () => {}, onSettled: () => { settled++; }, execute: async () => {
    peak = Math.max(peak, ++active); await wait(10); active--;
    return { status: "failed" as const, reason: "Synthetic fixture result" };
  } };
  try {
    expect((await runGoldenCampaign(options)).status).toBe("automatic-lane-settled");
    expect({ active, peak, configured, settled }).toEqual({ active: 0, peak: 2, configured: 1, settled: 2 });
    expect(queue.running()).toEqual([]);
    const token = queue.acquireRunner(); queue.releaseRunner(token);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an observed reset backs off without claiming or configuring work and cancellation stops the wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-backoff-"));
  const queue = new GoldenQueue(join(root, "queue.sqlite"), { snapshot, implementationSha256: "b".repeat(64) });
  const controller = new AbortController(); let called = false;
  try {
    queue.deferUntil(Date.now() + 3600_000, "Observed reset");
    const result = await runGoldenCampaign({ queue, signal: controller.signal, configure: async () => { throw new Error("No configure during backoff"); }, admission: async () => {}, execute: async () => { throw new Error("No execute during backoff"); }, onSettled: () => {}, onBackoff: observation => { called = true; expect(observation.reason).toBe("Observed reset"); controller.abort(); } });
    expect(called).toBe(true);
    expect(result.status).toBe("stopped");
    expect(queue.running()).toEqual([]);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a persisted admission hold survives restart and prevents configuration or claims", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-admission-hold-")), path = join(root, "queue.sqlite");
  let queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  try {
    const hold = queue.suspendAdmission({ code: "rate_limit_exceeded", reason: "Native account limit without a reset time", evidence: "/fixture/bundle.zip", threadId: "owned-thread", turnId: "owned-turn" });
    const before = queue.summary().counts.pending;
    queue.close(); queue = new GoldenQueue(path);
    expect(queue.summary().admissionHold).toEqual(hold);
    const schedule = queue.nextSchedule()!;
    expect(queue.claim(schedule)).toBeNull();
    let calls = 0;
    const result = await runGoldenCampaign({ queue, signal: new AbortController().signal, configure: async () => { calls++; }, admission: async () => { calls++; }, onBackoff: () => {}, onSettled: () => {}, execute: async () => { calls++; throw new Error("Must not execute"); } });
    expect(result.status).toBe("admission-suspended");
    expect(calls).toBe(0);
    expect(queue.summary().counts.pending).toBe(before);
    expect(() => queue.resumeAdmission({ expectedHoldId: "stale", reason: "Reviewed reset", evidence: "/fixture/reset.json" })).toThrow();
    queue.resumeAdmission({ expectedHoldId: hold.id, reason: "Reviewed reset", evidence: "/fixture/reset.json" });
    expect(queue.summary().admissionHold).toBeUndefined();
    expect(queue.claim(schedule)).not.toBeNull();
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("account suspension preserves unresolved claims and persists the admission constraint", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-limited-attempt-")), path = join(root, "queue.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  const observation = { code: "rate_limit_exceeded" as const, reason: "Observed native account limit", evidence: "/fixture/limited.zip", threadId: "limited-thread", turnId: "limited-turn" };
  let executions = 0;
  const options = { queue, signal: new AbortController().signal, configure: async () => {}, admission: async () => {}, onBackoff: () => {}, onSettled: () => { throw new Error("Uncertain work must not settle"); }, executeBatch: async () => { executions++; throw new GoldenAdmissionSuspended(observation); } };
  try {
    await expect(runGoldenCampaign(options)).rejects.toThrow("reconciliation");
    expect(queue.summary().admissionHold).toMatchObject(observation);
    expect(queue.running()).toHaveLength(1);
    expect((await runGoldenCampaign(options)).status).toBe("reconciliation-required");
    expect(executions).toBe(1);
    expect(() => queue.resumeAdmission({ expectedHoldId: queue.summary().admissionHold!.id, reason: "Reset reviewed", evidence: "/fixture/reset.json" })).toThrow("Resolve owned attempts");
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});
