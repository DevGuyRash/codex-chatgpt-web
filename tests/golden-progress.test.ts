import { expect, test } from "bun:test";
import { ActiveProgress } from "../scripts/golden/progress";
const evidence = (n: number) => ({ traceId: "a".repeat(32), kind: "attachment" as const, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, sha256: "b".repeat(64) });

test("progress excludes silence, phase changes, queued time, duplicates and final waiting", () => {
  const clock = new ActiveProgress();
  clock.observe(0, "generation", evidence(1));
  clock.observe(1000, "generation", evidence(2));
  clock.observe(2000, "generation", evidence(2));
  clock.observe(3000, "generation", evidence(3));
  clock.pause(4000);
  clock.observe(500_000, "generation", evidence(4));
  clock.observe(510_000, "tools", evidence(5));
  clock.observe(520_000, "tools", evidence(6));
  clock.observe(560_000, "tools", evidence(7));
  clock.observe(561_000, "tools", evidence(8));
  const result = clock.finishBatch(999_999, true);
  expect(result.creditedMs).toBe(14_000);
  expect(result.segments).toHaveLength(4);
  expect(clock.activeProgressMs).toBe(14_000);
});

test("failed batches and observation restarts cannot earn or bridge accepted progress", () => {
  const clock = new ActiveProgress();
  clock.observe(0, "reasoning", evidence(1)); clock.observe(1000, "reasoning", evidence(2));
  expect(clock.finishBatch(2000, false)).toMatchObject({ observedMs: 1000, creditedMs: 0, acceptedMs: 0 });
  clock.observe(3000, "reasoning", evidence(3));
  expect(clock.finishBatch(4000, true).creditedMs).toBe(0);
  const restarted = new ActiveProgress();
  restarted.observe(5000, "reasoning", evidence(4));
  expect(restarted.finishBatch(6000, true).creditedMs).toBe(0);
  expect(() => clock.observe(1, "generation", evidence(5))).toThrow("monotonic");
  expect(() => new ActiveProgress(31_000)).toThrow("gap");
});
