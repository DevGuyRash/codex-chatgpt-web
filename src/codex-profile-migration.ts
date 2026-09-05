import { dirname, join } from "node:path";
import { getConfigPath, loadConfig } from "./config";
import type { IntegrationTarget } from "./contracts/codex-integration";
import { resolveIntegrationTarget } from "./codex-integration-target";
import { readJournal } from "./codex-integration-journal";
import { replacementBaseline, restoreManagedRoute, verifyManagedJournalState } from "./codex-integration-route";
import { assertProfileBaseLayer } from "./codex-profile-layers";
import { getCodexJournalPath, getCodexJournalRecoveryPath, sha256, snapshotFile } from "./codex-integration-shared";

/** A combined plan only: no base mutation occurs while a profile preview is being built. */
export function prepareBaseToProfileMigration(target: IntegrationTarget) {
  if (target.kind !== "profile") throw new Error("Base migration requires a named profile target");
  const base = resolveIntegrationTarget({ codexHome: target.codexHome, runtimeRoot: dirname(dirname(target.runtimeHome)) });
  const inputs = [base.configPath, getCodexJournalPath(base), getCodexJournalRecoveryPath(base), getConfigPath(base.runtimeHome)].map(snapshotFile);
  const journal = readJournal({ target: base, repair: false });
  if (!journal || journal.version !== 10 || !journal.active) throw new Error("Migration requires an active version 10 base installation with readable ownership records");
  const config = loadConfig(base.runtimeHome);
  if (config.integrationTarget && config.integrationTarget.id !== base.id) throw new Error("Base runtime configuration belongs to another target");
  if (`http://${config.host}:${config.port}/v1` !== journal.installed.openai_base_url) throw new Error("Base runtime endpoint differs from its installation journal; repair that ownership before migration");
  const original = inputs[0]!.data?.toString("utf8");
  if (original === undefined) throw new Error("Base configuration is missing; restore it before migration");
  let restored: string;
  try { verifyManagedJournalState(original, journal); restored = restoreManagedRoute(original, journal); }
  catch { restored = replacementBaseline(original, true, journal); }
  assertProfileBaseLayer(restored, base.configPath);
  const archive = join(base.runtimeHome, "codex", "migrations", sha256(JSON.stringify([base.id, target.id, ...inputs.map(input => input.data ? sha256(input.data) : null)])));
  const writes = [{ path: base.configPath, data: restored }];
  for (const input of inputs.slice(1, 3)) {
    if (input.data) writes.push({ path: join(archive, input === inputs[1] ? "integration-journal.json" : "integration-journal.recovery.json"), data: input.data.toString("utf8") });
  }
  writes.push({ path: join(archive, "receipt.json"), data: `${JSON.stringify({ version: 1, from: base, to: target, beforeHash: sha256(original), afterHash: sha256(restored) }, null, 2)}\n` });
  for (const write of writes.slice(1)) {
    const input = snapshotFile(write.path);
    if (input.exists && input.data?.toString("utf8") !== write.data) throw new Error("Migration archive already contains different restoration evidence");
    inputs.push(input);
  }
  return { base, original, restored, archive, endpoint: { host: config.host, port: config.port }, expected: inputs, writes,
    removals: [getCodexJournalPath(base), getCodexJournalRecoveryPath(base)] };
}
