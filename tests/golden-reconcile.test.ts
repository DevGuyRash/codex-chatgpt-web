import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { goldenImplementationIdentity } from "../scripts/golden/implementation";
import { reconcileGoldenImplementation } from "../scripts/golden/reconcile";
import { GoldenQueue } from "../scripts/golden/queue";

test("implementation cutover validates reviewed bytes and retains every manifest before changing coverage", () => {
  const repository = mkdtempSync(join(tmpdir(), "golden-reconcile-")), root = join(repository, "campaign"), reviewPath = join(root, "review.json");
  try {
    expect(Bun.spawnSync(["git", "-C", repository, "init", "-q"]).exitCode).toBe(0);
    mkdirSync(join(repository, "src")); mkdirSync(join(repository, "scripts/golden"), { recursive: true }); mkdirSync(root);
    writeFileSync(join(repository, "src/main.ts"), "export const value = 1;");
    writeFileSync(join(repository, "scripts/golden/main.ts"), "export const check = true;");
    const before = goldenImplementationIdentity(repository), manifestText = JSON.stringify(before, null, 2);
    writeFileSync(join(root, "campaign-implementation.json"), manifestText);
    const queue = new GoldenQueue(join(root, "campaign.sqlite"), { implementationSha256: before.sha256, snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", capabilities: { solAvailable: true, proAvailable: true }, nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64) } });
    const claim = queue.claim({ lane: "serial", protocol: "native" })!;
    queue.settle(claim.cell.id, claim.token, { status: "passed", reason: "Synthetic accepted fixture", evidence: "/fixture/bundle.zip", verification: { checks: ["artifacts", "commit", "settlement", "diagnostics", "no-duplicate-effects", `variant:${claim.cell.variant.id}`], observedModel: claim.cell.route.backendModel, observedEffort: claim.cell.route.adapterEffort, activeProgressMs: 0, bundleSha256: "d".repeat(64) } });
    queue.close();
    const changed = () => goldenImplementationIdentity(repository);
    const review = (previous: string, next: string) => JSON.stringify({ expectedImplementationSha256: previous, implementationSha256: next, reason: "Reviewed synthetic source change requires fresh coverage.", verification: ["Local contract fixture passed."] });
    writeFileSync(join(repository, "src/main.ts"), "export const value = 2;");
    writeFileSync(reviewPath, review(before.sha256, "b".repeat(64)));
    const apply = () => reconcileGoldenImplementation({ root, repository, runtimeArtifacts: [], reviewPath });
    expect(() => apply()).toThrow("reviewed implementation differs");
    const current = changed(); writeFileSync(reviewPath, review(before.sha256, current.sha256));
    const result = apply();
    expect(result.requeuedCellIds).toEqual([claim.cell.id]);
    expect(result.summary.counts.passed).toBeUndefined();
    expect(readFileSync(join(root, "implementations", `${before.sha256}.json`), "utf8")).toBe(manifestText);
    expect(readFileSync(result.review, "utf8")).toBe(readFileSync(reviewPath, "utf8"));
    expect(readFileSync(join(root, "campaign-implementation.json"), "utf8")).toBe(manifestText);
    // Another reviewed change can follow before any new generation, using the retained manifest.
    writeFileSync(join(repository, "src/main.ts"), "export const value = 3;");
    writeFileSync(reviewPath, review(current.sha256, changed().sha256));
    expect(apply().requeuedCellIds).toEqual([]);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});
