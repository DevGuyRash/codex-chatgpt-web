import { expect, test } from "bun:test";
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
