import { expect, test } from "bun:test";
import { runStructuredCompactionOnce, structuredCompactionSettlementForNativeTurn } from "../src/adapters/chatgpt-web/compaction-handoff";

test("exact-turn cleanup remains pending after a compaction result fails until its physical owner settles", async () => {
  let release!: () => void;
  const physical = new Promise<void>(resolve => { release = resolve; });
  const result = runStructuredCompactionOnce("cleanup-result-fixture", {
    ownerKey: "cleanup-owner-fixture", traceIds: ["cleanup-trace-fixture"],
    nativeThreadId: "cleanup-thread-fixture", nativeTurnId: "cleanup-turn-fixture",
  }, async (_signal, retain) => { retain(physical); throw new Error("handoff deadline"); });
  await expect(result).rejects.toThrow("handoff deadline");
  let settled = false;
  const cleanup = structuredCompactionSettlementForNativeTurn("cleanup-thread-fixture", "cleanup-turn-fixture")
    .then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally { release(); await cleanup; }
  expect(settled).toBe(true);
});
