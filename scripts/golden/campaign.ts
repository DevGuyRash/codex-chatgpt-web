import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { defaultConfig } from "../../src/config";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { assertBorrowedTunnelInactive } from "./borrowed-tunnel";
import type { CapabilitySnapshot } from "./catalog";
import { goldenImplementationIdentity, verifyGoldenBrowserHelper } from "./implementation";
import { liveCampaignExecutor } from "./live-campaign";
import { GoldenQueue } from "./queue";
import { runGoldenCampaign } from "./runner";
import { goldenNativeEnvironment } from "./runtime-config";
import { ownsProcess, type GoldenWorkspace } from "./workspace";
import { readGoldenSourceRuntime } from "./source-runtime";

/** Continuous local entrypoint. Matrix coverage and executor availability remain separate. */
export async function runLiveCampaign(options: { root: string; repository: string; sourceHome?: string; executable: string; turnTimeoutMs: number; controller: AbortController; stopAfterSettled?: number }) {
  const root = resolve(options.root), queuePath = join(root, "campaign.sqlite"), signal = options.controller.signal;
  signal.throwIfAborted();
  if (options.stopAfterSettled !== undefined && (!Number.isSafeInteger(options.stopAfterSettled) || options.stopAfterSettled < 1)) throw new Error("A bounded campaign observation requires a positive settled-cell count");
  const workspace = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8")) as GoldenWorkspace;
  if (workspace.root !== root || !workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)) throw new Error("Campaign startup requires its owned isolated launcher");
  const { home: sourceHome, config: source } = readGoldenSourceRuntime(options.sourceHome);
  await assertBorrowedTunnelInactive(sourceHome, root, source);
  const descriptor = readLauncherBrowserHostDescriptor(workspace.descriptorPath);
  const artifacts = [options.executable, process.execPath, descriptor.helper.script];
  const implementation = goldenImplementationIdentity(options.repository, artifacts);
  // Inspect retained claims before any browser acquisition. A dead owner is not settlement.
  if (existsSync(queuePath)) {
    const prior = new GoldenQueue(queuePath);
    try {
      if (prior.running().length) return { status: "reconciliation-required" as const, running: prior.running(), summary: prior.summary() };
      if (prior.summary().admissionHold) return { status: "admission-suspended" as const, summary: prior.summary() };
    }
    finally { prior.close(); }
  }
  verifyGoldenBrowserHelper(options.repository, descriptor.helper.script);
  const home = join(root, "catalog-inspection"); mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = goldenNativeEnvironment(root, home, options.executable);
  const inspectNative = (...args: string[]) => {
    const result = spawnSync(options.executable, args, { cwd: root, env, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("The selected native executable did not expose its offline identity");
    return result.stdout;
  };
  const catalog = inspectNative("debug", "models", "--bundled"), version = inspectNative("--version").trim();
  const inspected = await inspectLauncherBrowserHost(workspace.descriptorPath, { detectCapabilities: true });
  if (typeof inspected.solAvailable !== "boolean" || typeof inspected.proAvailable !== "boolean") throw new Error("Campaign inspection did not establish account capabilities");
  const defaults = defaultConfig("full", workspace.runtimeHome);
  const snapshot: CapabilitySnapshot = { inspectedAt: new Date().toISOString(), source: "launcher-session-inspection", nativeCodexVersion: version, nativeCatalogSha256: createHash("sha256").update(catalog).digest("hex"), capabilities: { solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable, experimentalBiggerContext: defaults.experimentalBiggerContext, browserInteractionMode: "automatic" } };
  const queue = existsSync(queuePath) ? new GoldenQueue(queuePath) : new GoldenQueue(queuePath, { snapshot, implementationSha256: implementation.sha256 });
  try {
    if (queue.implementationSha256 !== implementation.sha256 || queue.snapshot.nativeCodexVersion !== snapshot.nativeCodexVersion || queue.snapshot.nativeCatalogSha256 !== snapshot.nativeCatalogSha256 || JSON.stringify(queue.snapshot.capabilities) !== JSON.stringify(snapshot.capabilities)) throw new Error("Campaign implementation or inspected capabilities changed; retained coverage requires reconciliation");
    writeFileSync(join(root, "campaign-implementation.json"), JSON.stringify(implementation, null, 2), { mode: 0o600 });
    const executor = liveCampaignExecutor({ ...options, sourceHome });
    let settled = 0;
    const unchanged = () => { if (goldenImplementationIdentity(options.repository, artifacts).sha256 !== implementation.sha256) throw new Error("Campaign implementation changed while work was in flight; reconcile its evidence before continuing"); };
    return await runGoldenCampaign({ queue, signal, canExecute: executor.canExecute,
      configure: async () => {}, // The batch owner applies configuration only after obtaining its exact cells.
      admission: async () => { unchanged(); await assertBorrowedTunnelInactive(sourceHome, root, source); signal.throwIfAborted(); },
      executeBatch: async (attempts, signal) => { const outcomes = await executor.executeBatch(attempts, signal); unchanged(); return outcomes; },
      onBackoff: observation => { console.log(JSON.stringify({ status: "backoff", ...observation })); },
      onSettled: (cell, outcome) => {
        console.log(JSON.stringify({ cell: cell.id, route: cell.route.slug, workload: cell.workload, protocol: cell.protocol, variant: cell.variant.id, lane: cell.lane, outcome, summary: queue.summary() }));
        if (outcome.status === "failed" || outcome.status === "blocked") options.controller.abort(new Error("The campaign requires investigation of its settled failure"));
        if (options.stopAfterSettled !== undefined && ++settled >= options.stopAfterSettled) options.controller.abort(new Error("The requested bounded campaign observation settled"));
      },
    });
  } finally { queue.close(); }
}

if (import.meta.main) {
  const controller = new AbortController(), stop = () => controller.abort(new Error("Campaign observation cancelled"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { console.log(JSON.stringify(await runLiveCampaign({ root: process.argv[2] ?? "context/golden/live", repository: resolve(import.meta.dir, "../.."), executable: process.argv[3] ?? "/usr/lib/chatgpt/resources/codex", sourceHome: process.argv[4], turnTimeoutMs: 30 * 60 * 1000, controller, ...(process.argv[5] === undefined ? {} : { stopAfterSettled: Number(process.argv[5]) }) }))); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
