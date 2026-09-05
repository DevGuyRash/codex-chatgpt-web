import { expect, test } from "bun:test";
import { withConfigurationReview } from "../src/codex-configuration-review";
import { resolveIntegrationTarget } from "../src/codex-integration-target";
import type { CodexRepairPreview } from "../src/contracts/codex-integration";

const preview: CodexRepairPreview = { version: 1, status: "blocked", approvalId: "", protocol: "native", changes: [], conflicts: [], codexRestartRequired: true, launcherRestartRequired: true };
const target = resolveIntegrationTarget({ codexHome: "/tmp/config-review-fixture", runtimeRoot: "/tmp/runtime-review-fixture", profile: "test" });
test("review groups all competing definitions and retains every finding", () => {
  const result = withConfigurationReview({ ...preview, conflicts: [
    { path: "openai_base_url", category: "invalid_config", message: "Duplicate" },
    { path: "openai_base_url", category: "ownership_conflict", message: "Unclaimed" },
  ] }, target, 'openai_base_url="one"\nopenai_base_url="two"\n');
  expect(result.version).toBe(2);
  const setting = result.groups![0]!.settings[0]!;
  expect(setting.occurrences).toHaveLength(2);
  expect(setting.findings).toHaveLength(2);
  expect(setting.current).toBeNull();
  expect(setting.state).toBe("ambiguous");
  expect(setting.resolutionRequired).toBe(true);
});
test("a profile override is not a duplicate; inheritance is explicit", () => {
  const result = withConfigurationReview(preview, target, 'openai_base_url="profile"\n', { baseSource: 'openai_base_url="base"\n[features]\nmulti_agent=true\n' });
  const connection = result.groups!.find(group => group.id === "connection")!.settings[0]!;
  expect(connection.current).toBe("profile");
  expect(connection.inherited).toBe(false);
  expect(connection.resolutionRequired).toBe(false);
  expect(connection.occurrences).toHaveLength(2);
  expect(result.groups!.find(group => group.id === "subagents")!.settings[0]!.inherited).toBe(true);
});
