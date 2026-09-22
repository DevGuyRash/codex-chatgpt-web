import { expect, test } from "bun:test";
import { configurationSummary } from "../src/configuration-summary";
import type { CodexRepairPreview } from "../src/contracts/codex-integration";

const preview: CodexRepairPreview = { version: 1, protocol: "native", status: "ready", approvalId: "a".repeat(64), changes: [], conflicts: [], codexRestartRequired: false, launcherRestartRequired: false };
test("configuration summaries use the approved preview and keep no-change separate from risk", () => {
  expect(configurationSummary(preview)).toMatchObject({ settings: 0, tone: "success" });
  const changes = [{ path: "base_url", current: "old", proposed: "new" }];
  expect(configurationSummary({ ...preview, changes })).toMatchObject({ settings: 1, tone: "info" });
  expect(configurationSummary({ ...preview, status: "blocked", changes: [], conflicts: [{ path: "hook", category: "ownership_conflict", message: "Unresolved hook" }] })).toMatchObject({ settings: 0, conflicts: 1, tone: "error" });
  const setting = { path: "base_url", current: "old", proposed: "new", state: "active" as const, inherited: false, occurrences: [], findings: [], resolutionRequired: false };
  expect(configurationSummary({ ...preview, version: 2, changes, groups: [{ id: "connection", settings: [setting] }] })).toMatchObject({ settings: 1, tone: "info" });
  expect(configurationSummary({ ...preview, version: 2, groups: [{ id: "connection", settings: [{ ...setting, resolutionRequired: true }] }] })).toMatchObject({ tone: "warning" });
});
