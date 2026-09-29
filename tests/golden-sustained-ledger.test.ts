import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveProgress } from "../scripts/golden/progress";
import { SustainedProgressLedger } from "../scripts/golden/sustained-ledger";

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
    expect(ledger.append({ batch: 0, threadId: thread, commit: "1".repeat(40), bundleSha256: "2".repeat(64), independentlyValid: true, progress: first })).toBe(20_000);
    const restored = new SustainedProgressLedger(path, cell, thread);
    expect({ next: restored.nextBatch, credited: restored.activeProgressMs, complete: restored.minimumMet }).toEqual({ next: 1, credited: 20_000, complete: false });
    expect(() => restored.append({ batch: 0, threadId: thread, commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(4, 1_030_000) })).toThrow("sequence changed");
    expect(() => restored.append({ batch: 1, threadId: thread, commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(2, 1_030_000) })).toThrow("duplicated");
    expect(restored.activeProgressMs).toBe(20_000);
    expect(restored.append({ batch: 1, threadId: thread, commit: "3".repeat(40), bundleSha256: "4".repeat(64), independentlyValid: true, progress: progress(4, 1_030_000) })).toBe(40_000);
    expect(new SustainedProgressLedger(path, cell, thread).activeProgressMs).toBe(40_000);
    expect(() => new SustainedProgressLedger(path, "d".repeat(64), thread)).toThrow("owner changed");
    const changed = JSON.parse(readFileSync(path, "utf8")); changed.entries[0].observedMs += 1000;
    writeFileSync(path, JSON.stringify(changed), { mode: 0o600 });
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("hash changed");
    chmodSync(path, 0o644);
    expect(() => new SustainedProgressLedger(path, cell, thread)).toThrow("not private and owned");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
