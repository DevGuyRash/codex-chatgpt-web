import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { runtimeDiagnostics } from "../../src/diagnostics/runtime";
import { GoldenAdmissionSuspended } from "./admission";
import { GoldenQueue } from "./queue";

// This reduces burst pressure in synthetic campaigns. It is not a provider quota or reset claim.
const TOP_LEVEL_GENERATION_SPACING_MS = 3 * 60_000;

export async function paceGoldenGeneration(root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const queuePath = join(root, "campaign.sqlite");
  const reserve = new GoldenQueue(queuePath);
  let notBefore: number;
  try {
    const hold = reserve.summary().admissionHold;
    if (hold) {
      const { id: _id, observedAt: _observedAt, ...observation } = hold;
      throw new GoldenAdmissionSuspended(observation);
    }
    notBefore = reserve.reserveGenerationNotBefore(TOP_LEVEL_GENERATION_SPACING_MS);
  } finally { reserve.close(); }
  const diagnostics = runtimeDiagnostics();
  const delay = async () => {
    const remaining = Math.max(0, notBefore - Date.now());
    if (remaining) await wait(remaining, undefined, { signal });
    signal.throwIfAborted();
  };
  if (diagnostics) await diagnostics.run("golden.generation_pacing", delay);
  else await delay();
  const current = new GoldenQueue(queuePath);
  try {
    const hold = current.summary().admissionHold;
    if (hold) {
      const { id: _id, observedAt: _observedAt, ...observation } = hold;
      throw new GoldenAdmissionSuspended(observation);
    }
  } finally { current.close(); }
  signal.throwIfAborted();
}
