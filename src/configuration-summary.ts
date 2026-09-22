import type { CodexRepairPreview, ConfigurationReviewSetting } from "./contracts/codex-integration";
import type { AppConfig } from "./config";

/** Runtime inputs that change Codex's advertised model catalog independently of TOML. */
export function catalogConfigurationKey(config: Partial<AppConfig> | undefined): string {
  if (!config) return "missing-runtime-config";
  return JSON.stringify([
    config.mode, config.subagentProtocol, config.releaseVersion,
    config.solAvailable, config.proAvailable, config.experimentalBiggerContext ?? false,
    config.browserInteractionMode ?? "automatic", config.zeroRiskProEnabled ?? false,
  ]);
}

export function configurationChangeKind(setting: ConfigurationReviewSetting) {
  return setting.changeKind ?? (setting.state === "ambiguous" ? "unresolved" : setting.state === "commented_out" ? "added" : setting.current === setting.proposed ? "unchanged" : setting.current == null ? "added" : setting.proposed == null ? "removed" : "changed");
}

/** Counts derive from the same preview that is approved and applied. Counts are not risk scores. */
export function configurationSummary(preview: CodexRepairPreview) {
  const settings = preview.groups?.flatMap(group => group.settings) ?? [];
  const changes = new Set(preview.changes.filter(change => change.current !== change.proposed || change.currentState === "commented_out").map(change => change.path));
  for (const setting of settings) if (!["unchanged", "unresolved"].includes(configurationChangeKind(setting))) changes.add(setting.path);
  const relatedChanges = preview.additionalTargets?.reduce((count, target) => count + target.groups.flatMap(group => group.settings).filter(setting => !["unchanged", "unresolved"].includes(configurationChangeKind(setting))).length, 0) ?? 0;
  const files = new Set(preview.textChanges?.filter(change => change.before !== change.after).map(change => change.path)).size;
  const attention = settings.filter(setting => setting.resolutionRequired || setting.findings.length).length;
  const conflicts = preview.conflicts.length;
  const count = changes.size + relatedChanges;
  const tone = preview.status === "blocked" ? "error" : attention || conflicts ? "warning" : count || files ? "info" : "success";
  return { settings: count, files, attention, conflicts, tone } as const;
}
