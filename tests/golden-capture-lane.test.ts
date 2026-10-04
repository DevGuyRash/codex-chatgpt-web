import { expect, spyOn, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { GoldenCaptureLane } from "../scripts/golden/capture-lane";

const receipt = (index: number) => ({ traceId: "a".repeat(32), kind: "attachment" as const,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, sha256: "b".repeat(64) });

test("native capture acknowledges prior receipt times without charging storage latency", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  const lane = new GoldenCaptureLane(async () => { if (count === 0) await held; return receipt(++count); });
  await lane.record("transport", "first delta", "generation", 1000);
  await lane.record("transport", "second delta", "generation", 2000);
  await Bun.sleep(40);
  release();
  const result = await lane.finishBatch(true);
  expect(result.observedMs).toBe(1000);
  expect(result.creditedMs).toBe(1000);
  expect(result.segments).toHaveLength(1);
});

test("a repeated native frame cannot earn time by changing only its receipt timestamp", async () => {
  let count = 0;
  const lane = new GoldenCaptureLane(async () => receipt(++count));
  await lane.record("transport", JSON.stringify({ direction: "received", message: { method: "item/agentMessage/delta", params: { delta: "same" } }, receivedAtMs: 1000 }), "generation", 1000);
  await lane.record("transport", JSON.stringify({ direction: "received", message: { method: "item/agentMessage/delta", params: { delta: "same" } }, receivedAtMs: 2000 }), "generation", 2000);
  const result = await lane.finishBatch(true);
  expect(result.observedMs).toBe(0);
  expect(result.creditedMs).toBe(0);
});

test("renumbered native deltas cannot earn or bridge productive time", async () => {
  let count = 0;
  const lane = new GoldenCaptureLane(async () => receipt(++count));
  const frame = (at: number, itemId: string, delta: string) => JSON.stringify({
    direction: "received", receivedAtMs: at,
    message: { method: "item/agentMessage/delta", params: { threadId: "owned-task", turnId: "owned-turn", itemId, delta } },
  });
  await lane.record("transport", frame(1000, "first", "same"), "generation", 1000);
  await lane.record("transport", frame(2000, "renumbered", "same"), "generation", 2000);
  await lane.record("transport", frame(3000, "next", "new"), "generation", 3000);
  await lane.record("transport", frame(3500, "another", "more"), "generation", 3500);
  const result = await lane.finishBatch(true);
  expect(result.observedMs).toBe(500);
  expect(result.creditedMs).toBe(500);
  expect(result.segments).toHaveLength(1);
});

test("prompt capture fences submission and a saturated native backlog fails closed", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let submitted = false;
  const lane = new GoldenCaptureLane(async (_category, text) => { await held; return receipt(Number(text)); });
  const prompt = lane.record("prompt", "1").then(() => { submitted = true; });
  await Bun.sleep(0);
  expect(submitted).toBe(false);
  for (let index = 2; index <= 128; index += 1) await lane.record("transport", String(index));
  await expect(lane.record("transport", "129")).rejects.toThrow("backlog exceeded");
  release();
  await expect(prompt).rejects.toThrow("backlog exceeded");
  await expect(lane.flush()).rejects.toThrow("backlog exceeded");
  expect(submitted).toBe(false);
});

test("delayed frames retain their original receipts without bridging a durable input boundary", async () => {
  const now = spyOn(performance, "now").mockReturnValue(3000 - performance.timeOrigin);
  const retained: string[] = [];
  const lane = new GoldenCaptureLane(async (_category, text) => { retained.push(text); return receipt(retained.length); });
  try {
    await lane.record("transport", "before one", "generation", 1000);
    await lane.record("transport", "before two", "generation", 2000);
    await lane.record("prompt", "new input");
    await lane.record("transport", "delayed old frame", "generation", 2500);
    await lane.record("transport", "same boundary frame", "generation", 3000);
    await lane.record("transport", "delayed old frame", "generation", 4000);
    await lane.record("transport", "fresh one", "generation", 5000);
    await lane.record("transport", "fresh two", "generation", 6000);
    now.mockReturnValue(7000 - performance.timeOrigin);
    const progress = await lane.finishBatch(true);
    expect(retained).toEqual(["before one", "before two", "new input", "delayed old frame", "same boundary frame", "delayed old frame", "fresh one", "fresh two"]);
    expect(progress.creditedMs).toBe(2000);
    expect(progress.segments.map(segment => [segment.startMs, segment.endMs])).toEqual([[1000, 2000], [5000, 6000]]);
  } finally { now.mockRestore(); }
});
