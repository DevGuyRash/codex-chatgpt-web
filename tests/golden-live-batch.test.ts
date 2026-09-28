import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenQueue } from "../scripts/golden/queue";
import { expect, test } from "bun:test";
import { retainLiveAdmissionFailure, runLiveBatch, type LiveBatchCell } from "../scripts/golden/live-batch";
import { CHATGPT_WEB_MODEL_ROUTES, CHATGPT_WEB_LUNA_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { isProGeneration } from "../src/campaign-policy";
import { nativeRateLimited } from "../scripts/golden/structured-scenarios";

test("native admission recognizes the observed exhausted HTTP 429 variant without broadening to other failures", () => {
  for (const [info, limited] of [["rateLimitExceeded", true], [{ responseTooManyFailedAttempts: { httpStatusCode: 429 } }, true], [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, false], [{ responseTooManyFailedAttempts: { httpStatusCode: "429" } }, false], ["other", false]] as const) {
    const turn = { id: "turn", status: "failed" as const, items: [], error: { codexErrorInfo: info, message: "Synthetic rate limit text 429" } };
    expect(nativeRateLimited(turn)).toBe(limited);
    expect(nativeRateLimited({ ...turn, status: "completed" })).toBeFalse();
  }
});

test("batch admission rejects prohibited or unsupported work before inspecting any live workspace", async () => {
  const cell: LiveBatchCell = { id: "a".repeat(64), routeSlug: "chatgpt-web/light", workload: 1, variant: "fresh" };
  const input = { root: "/nonexistent-golden-workspace", sourceHome: "/nonexistent-source", executable: "/nonexistent-native", signal: new AbortController().signal, turnTimeoutMs: 1000 };
  await expect(runLiveBatch({ ...input, cells: [cell, { ...cell, id: "b".repeat(64) }, { ...cell, id: "c".repeat(64) }] })).rejects.toThrow("one or two");
  await expect(runLiveBatch({ ...input, cells: [cell, cell] })).rejects.toThrow("distinct");
  const pro = CHATGPT_WEB_MODEL_ROUTES.find(isProGeneration)!;
  await expect(runLiveBatch({ ...input, cells: [{ ...cell, routeSlug: pro.slug }] })).rejects.toThrow("non-Pro");
  await expect(runLiveBatch({ ...input, cells: [{ ...cell, routeSlug: CHATGPT_WEB_LUNA_MODEL_ROUTES[0]!.slug, variant: "retained-conversation-change" }] })).rejects.toThrow("Sol retained-browser path");
  await expect(runLiveBatch({ ...input, cells: [{ ...cell, workload: 5 }] })).rejects.toThrow("sustained");
  const cancelled = new AbortController(); cancelled.abort(new Error("Cancelled before admission"));
  await expect(runLiveBatch({ ...input, signal: cancelled.signal, cells: [cell] })).rejects.toThrow("Cancelled before admission");
});

test("standalone live batches obey a persisted campaign admission hold before workspace access", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-batch-hold-"));
  const queue = new GoldenQueue(join(root, "campaign.sqlite"), { snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: false } }, implementationSha256: "b".repeat(64) });
  try {
    queue.suspendAdmission({ code: "rate_limit_exceeded", reason: "Retained account admission constraint", evidence: "/fixture/limited.zip", threadId: "thread", turnId: "turn" });
    await expect(runLiveBatch({ root, sourceHome: "/nonexistent-source", executable: "/nonexistent-native", signal: new AbortController().signal, turnTimeoutMs: 1000, cells: [{ id: "a".repeat(64), routeSlug: "chatgpt-web/light", workload: 1, variant: "fresh" }] })).rejects.toThrow("Retained account admission constraint");
    expect(queue.running()).toHaveLength(0);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("standalone native rate evidence durably fences later batches without export or claim settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-batch-rate-"));
  const database = join(root, "campaign.sqlite"), evidence = join(root, "native-admission.json");
  const queue = new GoldenQueue(database, { snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: false } }, implementationSha256: "b".repeat(64) });
  try {
    const before = queue.summary();
    expect(retainLiveAdmissionFailure(root, evidence, { threadId: "thread", turns: [{ id: "turn", status: "failed", items: [], error: { codexErrorInfo: "other", message: "rateLimitExceeded" } }] })).toBeUndefined();
    expect(existsSync(evidence)).toBeFalse();
    const failure = { threadId: "thread", turns: [{ id: "turn", status: "failed" as const, items: [], error: { codexErrorInfo: "rateLimitExceeded" } }] };
    const hold = retainLiveAdmissionFailure(root, evidence, failure)!;
    expect(JSON.parse(readFileSync(evidence, "utf8"))).toEqual({ code: hold.code, reason: hold.reason, evidence, threadId: "thread", turnId: "turn" });
    const reopened = new GoldenQueue(database);
    try { expect(reopened.summary().admissionHold).toEqual(hold); }
    finally { reopened.close(); }
    expect(queue.summary()).toEqual({ ...before, admissionHold: hold });
    expect(retainLiveAdmissionFailure(root, join(root, "second.json"), { ...failure, threadId: "second-thread" })).toEqual(hold);
    await expect(runLiveBatch({ root, sourceHome: "/nonexistent-source", executable: "/nonexistent-native", signal: new AbortController().signal, turnTimeoutMs: 1000, cells: [{ id: "a".repeat(64), routeSlug: "chatgpt-web/light", workload: 1, variant: "fresh" }] })).rejects.toThrow("Native account rate limit");
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rate admission survives unavailable evidence storage without claiming evidence completeness", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-rate-storage-"));
  const queue = new GoldenQueue(join(root, "campaign.sqlite"), { snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: false } }, implementationSha256: "b".repeat(64) });
  try {
    const evidence = join(root, "missing", "native.json");
    expect(() => retainLiveAdmissionFailure(root, evidence, { threadId: "thread", turns: [{ id: "turn", status: "failed", items: [], error: { codexErrorInfo: "rateLimitExceeded" } }] })).toThrow();
    expect(queue.summary().admissionHold).toMatchObject({ threadId: "thread", turnId: "turn", evidence });
    expect(existsSync(evidence)).toBeFalse();
    expect(queue.running()).toHaveLength(0);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});
