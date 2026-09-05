import { expect, test } from "bun:test";
import { targetDiscoveryChecks } from "../src/target-discovery-diagnostics";
import type { IntegrationTargetDiscovery } from "../src/contracts/codex-integration";

test("external links are informational and optional failures do not invalidate a connection", () => {
  const discovery: IntegrationTargetDiscovery = { entries: [
    { id: "link", kind: "profile", profile: "linked", codexHome: "/fixture", configPath: "/fixture/linked.config.toml", resolvedPath: "/managed/linked.toml", status: "external" },
    { id: "broken", kind: "profile", profile: "broken", codexHome: "/fixture", configPath: "/fixture/broken.config.toml", status: "unavailable" },
  ], issues: [{ code: "target_registry_unavailable", path: "/fixture/registry" }] };
  const checks = targetDiscoveryChecks(discovery);
  expect(checks.map(check => check.status)).toEqual(["ok", "warning", "warning"]);
  expect(checks[0]!.findings?.some(finding => finding.path === "/managed/linked.toml")).toBe(true);
  expect(checks.some(check => check.status === "error")).toBe(false);
});
