import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../src/config";
import { readLauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { buildGoldenMatrix } from "./catalog";
import { assertBorrowedTunnelInactive } from "./borrowed-tunnel";
import { goldenImplementationIdentity, verifyGoldenBrowserHelper } from "./implementation";
import { GoldenAdmissionSuspended } from "./admission";
import { canExecuteLiveCell, liveCampaignExecutor } from "./live-campaign";
import { GoldenQueue } from "./queue";
import { ownsProcess, type GoldenWorkspace } from "./workspace";

/** One exact serial cell; a failed producer keeps its durable claim for evidence review. */
export async function runSelectedGoldenCell(options: { root: string; executable: string; sourceHome: string; cellId: string; turnTimeoutMs: number; signal: AbortSignal }) {
  const root = resolve(options.root), executable = resolve(options.executable), sourceHome = resolve(options.sourceHome);
  if (!/^[a-f\d]{64}$/.test(options.cellId) || !Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1) throw new Error("Select one exact golden cell and a finite turn deadline");
  options.signal.throwIfAborted();
  const workspace = JSON.parse(readFileSync(`${root}/workspace.json`, "utf8")) as GoldenWorkspace;
  if (workspace.root !== root || !workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)) throw new Error("The selected golden workspace has no owned live launcher");
  const descriptor = readLauncherBrowserHostDescriptor(workspace.descriptorPath);
  const queue = new GoldenQueue(`${root}/campaign.sqlite`);
  try {
    const cell = buildGoldenMatrix(queue.snapshot).find(candidate => candidate.id === options.cellId);
    if (!cell || cell.lane !== "serial" || !canExecuteLiveCell(cell)) throw new Error("The selected cell is not an implemented serial non-Pro scenario");
    if (queue.running().length || queue.summary().admissionHold) throw new Error("Unresolved golden work or account admission prevents another cell");
    const identity = goldenImplementationIdentity(resolve(import.meta.dir, "../.."), [executable, process.execPath, descriptor.helper.script]);
    if (identity.sha256 !== queue.implementationSha256) throw new Error("The selected golden implementation requires reviewed reconciliation");
    verifyGoldenBrowserHelper(resolve(import.meta.dir, "../.."), descriptor.helper.script);
    await assertBorrowedTunnelInactive(sourceHome, root, loadConfig(sourceHome));
    const runner = queue.acquireRunner();
    try {
      const claim = queue.claim({ lane: cell.lane, protocol: cell.protocol, runnerToken: runner, eligible: candidate => candidate.id === cell.id });
      if (!claim || claim.cell.id !== cell.id) throw new Error("The selected golden cell was not uniquely admitted");
      const attempt = { ...claim, checkpoint: (input: Parameters<typeof queue.checkpoint>[2]) => queue.checkpoint(cell.id, claim.token, input) };
      const executor = liveCampaignExecutor({ root, sourceHome, executable, turnTimeoutMs: options.turnTimeoutMs });
      try {
        const outcomes = await executor.executeBatch([attempt], options.signal);
        const outcome = outcomes.get(cell.id);
        if (!outcome || outcomes.size !== 1) throw new Error("The selected golden cell has no unique outcome");
        queue.settle(cell.id, claim.token, outcome);
        return { cellId: cell.id, outcome, summary: queue.summary() };
      } catch (error) {
        if (error instanceof GoldenAdmissionSuspended) queue.suspendAdmission(error.observation);
        throw error;
      }
    } finally { queue.releaseRunner(runner); }
  } finally { queue.close(); }
}

if (import.meta.main) {
  if (process.argv.length !== 6) throw new Error("Usage: bun scripts/golden/one-cell.ts CAMPAIGN_ROOT NATIVE_EXECUTABLE SOURCE_HOME CELL_ID");
  const controller = new AbortController(), stop = () => controller.abort(new Error("Golden single-cell observation cancelled"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    console.log(JSON.stringify(await runSelectedGoldenCell({ root: process.argv[2]!, executable: process.argv[3]!, sourceHome: process.argv[4]!, cellId: process.argv[5]!, turnTimeoutMs: 30 * 60_000, signal: controller.signal })));
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
