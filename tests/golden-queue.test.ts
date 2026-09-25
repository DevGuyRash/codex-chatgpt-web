import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GoldenQueue } from "../scripts/golden/queue";
import type { CapabilitySnapshot } from "../scripts/golden/catalog";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const snapshot: CapabilitySnapshot = { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", capabilities: { solAvailable: true, proAvailable: true }, nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64) };

test("reviewed implementation reconciliation preserves attempts, refuses unresolved work and fences stale schedulers", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-revision-")), path = join(root, "campaign.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) }), stale = new GoldenQueue(path);
  const revision = { expectedImplementationSha256: "b".repeat(64), implementationSha256: "c".repeat(64), reason: "A reviewed driver change requires rerunning accepted coverage.", evidence: "/fixture/review.md", evidenceSha256: "d".repeat(64) };
  try {
    const claim = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.checkpoint(claim.cell.id, claim.token, { threadId: "retained-thread" });
    expect(() => queue.reconcileImplementation(revision)).toThrow("unresolved");
    queue.settle(claim.cell.id, claim.token, { status: "failed", reason: "Retained observed failure", evidence: "/fixture/attempt.zip" });
    const blocked = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.settle(blocked.cell.id, blocked.token, { status: "blocked", reason: "Uncertain tool effect requires manual review", evidence: "/fixture/unknown.zip" });
    const runner = queue.acquireRunner();
    expect(() => queue.reconcileImplementation(revision)).toThrow("scheduler");
    queue.releaseRunner(runner);
    expect(queue.reconcileImplementation(revision).requeuedCellIds).toEqual([claim.cell.id]);
    const database = new Database(path, { readonly: true });
    try { expect(database.query("SELECT status FROM cells WHERE id=?").get(blocked.cell.id)).toEqual({ status: "blocked" }); }
    finally { database.close(); }
    expect(queue.implementationSha256).toBe("c".repeat(64));
    expect(() => stale.acquireRunner()).toThrow("implementation changed");
    expect(() => stale.claim({ lane: "serial", protocol: "native" })).toThrow("implementation changed");
    expect(() => queue.reconcileImplementation(revision)).toThrow("implementation changed");
    const repeat = queue.claim({ lane: "serial", protocol: "native" })!;
    expect(repeat.cell.id).toBe(claim.cell.id);
    expect(repeat.token).not.toBe(claim.token);
    const db = new Database(path, { readonly: true });
    try {
      const attempts = db.query("SELECT attempt,implementation,checkpoint,outcome FROM attempts WHERE cell_id=? ORDER BY attempt").all(claim.cell.id) as { attempt: number; implementation: string; checkpoint: string | null; outcome: string | null }[];
      expect(attempts.map(attempt => attempt.implementation)).toEqual(["b".repeat(64), "c".repeat(64)]);
      expect(JSON.parse(attempts[0]!.checkpoint!)).toMatchObject({ threadId: "retained-thread" });
      expect(JSON.parse(attempts[0]!.outcome!)).toMatchObject({ status: "failed", evidence: "/fixture/attempt.zip" });
      expect(db.query("SELECT COUNT(*) AS n FROM implementation_revisions").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  } finally { stale.close(); queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("blocked unknown effects survive source revisions until their exact outcome is reviewed", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-blocked-review-")), path = join(root, "campaign.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  try {
    const claim = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.settle(claim.cell.id, claim.token, { status: "blocked", reason: "Tool receipt missing after diagnostic loss", evidence: "/fixture/loss.zip" });
    const db = new Database(path, { readonly: true });
    const row = db.query("SELECT attempt,outcome FROM cells WHERE id=?").get(claim.cell.id) as { attempt: number; outcome: string };
    db.close();
    expect(queue.reconcileImplementation({ expectedImplementationSha256: "b".repeat(64), implementationSha256: "c".repeat(64), reason: "Reviewed source update", evidence: "/fixture/revision.json", evidenceSha256: "d".repeat(64) }).requeuedCellIds).toEqual([]);
    const review = { id: claim.cell.id, expectedAttempt: row.attempt, expectedOutcomeSha256: createHash("sha256").update(row.outcome).digest("hex"), reason: "The prior effect was independently reconciled", evidence: "/fixture/effect-review.json" };
    expect(() => queue.resumeBlockedCell({ ...review, expectedOutcomeSha256: "0".repeat(64) })).toThrow("outcome changed");
    queue.resumeBlockedCell(review);
    const repeat = queue.claim({ lane: "serial", protocol: "native" })!;
    expect(repeat.cell.id).toBe(claim.cell.id);
    expect(repeat.token).not.toBe(claim.token);
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("durable claims preserve full coverage, serialize the serial lane and fence duplicate settlement", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-queue-")), path = join(root, "campaign.sqlite");
  const queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  const second = new GoldenQueue(path);
  try {
    const before = queue.summary();
    const claim = queue.claim({ lane: "serial", protocol: "native" })!;
    expect(claim.cell.lane).toBe("serial");
    expect(second.claim({ lane: "serial", protocol: "native" })).toBeNull();
    expect(second.claim({ lane: "concurrent", protocol: "native" })).toBeNull();
    expect(() => second.settle(claim.cell.id, "wrong-owner", { status: "failed", reason: "fixture" })).toThrow("claim");
    queue.settle(claim.cell.id, claim.token, { status: "failed", reason: "Observed fixture failure", evidence: "diagnostics/fixture.zip" });
    expect(() => queue.settle(claim.cell.id, claim.token, { status: "failed", reason: "duplicate" })).toThrow("claim");
    const a = queue.claim({ lane: "concurrent", protocol: "native" })!, b = second.claim({ lane: "concurrent", protocol: "native" })!;
    expect(a.cell.id).not.toBe(b.cell.id);
    expect(queue.claim({ lane: "concurrent", protocol: "native" })).toBeNull();
    expect(queue.claim({ lane: "concurrent", protocol: "compatibility-v1" })).toBeNull();
    expect(queue.summary().total).toBe(before.total);
    expect(queue.summary().counts.running).toBe(2);
    expect(queue.summary().counts.blocked).toBeGreaterThan(0);
  } finally { second.close(); queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reopening retains uncertain running work and observed backoff without automatic replay", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-resume-")), path = join(root, "campaign.sqlite");
  let queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  try {
    const claim = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.checkpoint(claim.cell.id, claim.token, { threadId: "native-thread", turnId: "native-turn", traceIds: ["c".repeat(32)] });
    queue.deferUntil(Date.now() + 60000, "Observed provider reset boundary");
    queue.close(); queue = new GoldenQueue(path);
    expect(queue.running()).toMatchObject([{ cell: { id: claim.cell.id }, checkpoint: { turnId: "native-turn" } }]);
    expect(queue.claim({ lane: "serial", protocol: "native" })).toBeNull();
    expect(() => new GoldenQueue(path, { snapshot, implementationSha256: "d".repeat(64) })).toThrow("implementation");
    expect(queue.summary().backoff?.reason).toContain("Observed");
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});

test("version-one queue migration preserves settled evidence and unresolved claim identities", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-schema-")), path = join(root, "campaign.sqlite");
  let queue = new GoldenQueue(path, { snapshot, implementationSha256: "b".repeat(64) });
  try {
    const settled = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.checkpoint(settled.cell.id, settled.token, { threadId: "settled-thread" });
    queue.settle(settled.cell.id, settled.token, { status: "failed", reason: "Retained version-one outcome", evidence: "/fixture/old.zip" });
    const running = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.checkpoint(running.cell.id, running.token, { threadId: "uncertain-thread", traceIds: ["c".repeat(32)] });
    queue.close();
    const prior = new Database(path);
    const rows = prior.query("SELECT * FROM cells ORDER BY ordinal").all();
    // Recreate exactly the previously supported schema, retaining its populated records.
    prior.exec("ALTER TABLE attempts DROP COLUMN implementation; ALTER TABLE attempts DROP COLUMN checkpoint; DROP TABLE implementation_revisions; PRAGMA user_version=1");
    prior.close();
    queue = new GoldenQueue(path);
    expect(queue.running()).toMatchObject([{ cell: { id: running.cell.id }, token: running.token, checkpoint: { threadId: "uncertain-thread" } }]);
    const migrated = new Database(path, { readonly: true });
    try {
      expect(migrated.query("SELECT * FROM cells ORDER BY ordinal").all()).toEqual(rows);
      expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      const attempts = migrated.query("SELECT implementation,checkpoint,outcome FROM attempts ORDER BY started").all() as { implementation: string; checkpoint: string; outcome: string | null }[];
      expect(attempts.map(attempt => attempt.implementation)).toEqual(["b".repeat(64), "b".repeat(64)]);
      expect(attempts.map(attempt => JSON.parse(attempt.checkpoint).threadId)).toEqual(["settled-thread", "uncertain-thread"]);
      expect(JSON.parse(attempts[0]!.outcome!)).toMatchObject({ evidence: "/fixture/old.zip" });
    } finally { migrated.close(); }
  } finally { queue.close(); rmSync(root, { recursive: true, force: true }); }
});
