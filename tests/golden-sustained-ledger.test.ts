import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveProgress } from "../scripts/golden/progress";
import { runSustainedBatchSequence, SustainedProgressLedger } from "../scripts/golden/sustained-ledger";

const thread = "11111111-1111-7111-8111-111111111111";
const cell = "a".repeat(64);
const evidence = (n: number) => ({ traceId: "b".repeat(32), kind: "attachment" as const,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sha256: "c".repeat(64) });
const progress = (first: number, at: number) => {
  const clock = new ActiveProgress();
  clock.observe(at, "tools", evidence(first));
  clock.observe(at + 10_000, "tools", evidence(first + 1));
  clock.observe(at + 20_000, "tools", evidence(first + 2));
  return clock.finishBatch(at + 21_000, true);
};

test("sustained credit survives restart without replaying a batch or duplicate progress evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-sustained-ledger-")), path = join(root, "ledger.json");
  try {
    const ledger = new SustainedProgressLedger(path, cell, thread);
    const first = progress(1, 1_000_000);
    expect(ledger.append({ ...ledger.reserveBatch(), threadId: thread, workloadId: "a".repeat(64), commit: "1".repeat(40), bundleSha256: "2".repeat(64), independentlyValid: true, progress: first })).toBe(20_000);
    const restored = new SustainedProgressLedger(path, cell, thread);
    expect({ next: restored.nextBatch, credited: restored.activeProgressMs, complete: restored.minimumMet }).toEqual({ next: 1, credited: 20_000, complete: false });
    const secondReservation = restored.reserveBatch();
    expect(() => restored.append({ ...secondReservation, batch: 0, threadId: thread, workloadId: "b".repeat(64), commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(4, 1_030_000) })).toThrow("not the exact reserved producer");
    expect(() => restored.append({ ...secondReservation, threadId: thread, workloadId: "b".repeat(64), commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(2, 1_030_000) })).toThrow("duplicated");
    expect(() => restored.append({ ...secondReservation, threadId: thread, workloadId: "a".repeat(64), commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(4, 1_030_000) })).toThrow("reused workload");
    expect(restored.activeProgressMs).toBe(20_000);
    expect(restored.append({ ...secondReservation, threadId: thread, workloadId: "b".repeat(64), commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(4, 1_030_000) })).toBe(40_000);
    expect(new SustainedProgressLedger(path, cell, thread).activeProgressMs).toBe(40_000);
    const fractionalClock = new ActiveProgress();
    fractionalClock.observe(1_060_000.125, "tools", evidence(7));
    fractionalClock.observe(1_061_000.5, "tools", evidence(8));
    const fractional = fractionalClock.finishBatch(1_061_001, true);
    const thirdReservation = restored.reserveBatch();
    expect(() => restored.append({ ...thirdReservation, threadId: thread, workloadId: "c".repeat(64), commit: "5".repeat(40), bundleSha256: "6".repeat(64), independentlyValid: true,
      progress: { observedMs: 0, creditedMs: 0, segments: [] } })).toThrow("positive observed segments");
    expect(restored.append({ ...thirdReservation, threadId: thread, workloadId: "c".repeat(64), commit: "5".repeat(40), bundleSha256: "6".repeat(64), independentlyValid: true, progress: fractional })).toBe(41_000.375);
    expect(() => new SustainedProgressLedger(path, "d".repeat(64), thread)).toThrow("owner changed");
    const changed = JSON.parse(readFileSync(path, "utf8")); changed.entries[0].observedMs += 1000;
    writeFileSync(path, JSON.stringify(changed), { mode: 0o600 });
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("hash changed");
    chmodSync(path, 0o644);
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("not private and owned");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an uncertain sustained producer blocks restart without resubmission", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-sustained-uncertain-")), path = join(root, "ledger.json");
  try {
    const ledger = new SustainedProgressLedger(path, cell, thread);
    let submissions = 0;
    await expect(runSustainedBatchSequence({ ledger, signal: new AbortController().signal, maxBatches: 2,
      beforeBatch: async () => {},
      executeBatch: async () => { submissions++; throw new Error("Native outcome unknown after Send"); },
      checkpoint: async () => {},
    })).rejects.toThrow("Native outcome unknown");
    const restarted = new SustainedProgressLedger(path, cell, thread);
    expect(restarted.pendingBatch).toBe(0);
    await expect(runSustainedBatchSequence({ ledger: restarted, signal: new AbortController().signal, maxBatches: 2,
      beforeBatch: async () => {}, executeBatch: async () => { submissions++; throw new Error("must not run"); }, checkpoint: async () => {},
    })).rejects.toThrow("unresolved producer");
    expect(submissions).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only an empty legacy ledger can upgrade without importing unbound credit", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-sustained-legacy-")), path = join(root, "ledger.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 1, cellId: cell, threadId: thread, entries: [] }), { mode: 0o600 });
    expect(new SustainedProgressLedger(path, cell, thread).nextBatch).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(2);
    writeFileSync(path, JSON.stringify({ version: 1, cellId: cell, threadId: thread, entries: [{}] }), { mode: 0o600 });
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("manual reconciliation");
    writeFileSync(path, JSON.stringify({ version: 1, cellId: cell, threadId: thread, entries: [], pending: {} }), { mode: 0o600 });
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("manual reconciliation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
