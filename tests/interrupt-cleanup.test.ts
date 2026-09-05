import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverInterruptCleanup, InterruptCleanupClaims } from "../src/interrupt-cleanup";
import { defaultConfig } from "../src/config";
import { HttpTurnCounter, startServer } from "../src/server";

const identity = { threadId: "thread_cleanup_test", turnId: "turn_cleanup_test" };
test("unavailable runtime is quiet for unrelated work and warns only on exact unresolved ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-cleanup-"));
  try {
    const claims = new InterruptCleanupClaims(root);
    expect(await deliverInterruptCleanup(undefined, identity, claims)).toBeUndefined();
    const release = claims.begin(identity);
    expect(await deliverInterruptCleanup(undefined, identity, claims)).toContain("could not confirm");
    expect(await deliverInterruptCleanup(undefined, { ...identity, turnId: "unrelated_turn" }, claims)).toBeUndefined();
    new InterruptCleanupClaims(root).captureSettlement(identity)();
    expect(claims.has(identity)).toBe(true);
    release();
    expect(claims.has(identity)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exact cancellation is delivered with no disk receipt and crash evidence is not erased by an idle new runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-cleanup-control-"));
  const previous = new InterruptCleanupClaims(root);
  const claims = new InterruptCleanupClaims(root);
  const config = { ...defaultConfig("browser-only", root), port: 0 };
  const server = startServer(config, { cleanupClaims: claims });
  try {
    config.port = server.port!;
    expect(await deliverInterruptCleanup(config, identity, claims)).toBeUndefined();
    previous.begin(identity);
    expect(await deliverInterruptCleanup(config, identity, claims)).toContain("not yet confirmed");
    expect(previous.has(identity)).toBe(true);
    expect(await deliverInterruptCleanup({ ...config, controlToken: "wrong" }, identity, claims)).toContain("could not confirm");
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP tracking records ownership before dispatch and retains interrupted uncertainty", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-cleanup-track-"));
  try {
    const claims = new InterruptCleanupClaims(root);
    const turns = new HttpTurnCounter(undefined, claims);
    await turns.track(async (_signal, bind) => { bind(identity); expect(claims.has(identity)).toBe(true); return new Response(null); });
    expect(claims.has(identity)).toBe(false);
    let finishPhysical!: () => void;
    const physical = new Promise<void>(resolve => { finishPhysical = resolve; });
    const retained = new HttpTurnCounter(undefined, claims, () => physical);
    await retained.track(async (_signal, bind) => { bind(identity); return new Response(null); });
    expect(claims.has(identity)).toBe(true);
    finishPhysical();
    await physical;
    expect(claims.has(identity)).toBe(false);
    turns.beginCancelTurn(identity);
    await turns.track(async (signal, bind) => { bind(identity); expect(signal.aborted).toBe(true); return new Response(null); });
    expect(claims.has(identity)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
