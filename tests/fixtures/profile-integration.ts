import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationTarget } from "../../src/contracts/codex-integration";
import { saveProfileCapabilities } from "../../src/codex-profile-capabilities";

// Unit evidence only. Real-binary acceptance is covered by the opt-in offline capability test.
export function unitProfileCapabilityFixture(target: IntegrationTarget, root: string): void {
  const executable = join(root, "unit-codex-binary");
  const bytes = "not executable: unit capability identity fixture";
  writeFileSync(executable, bytes);
  saveProfileCapabilities(target, { version: 1, executable, binarySha256: createHash("sha256").update(bytes).digest("hex"), codexVersion: "codex-cli 0.0.0", platform: process.platform,
    capabilities: ["profile-precedence", "profile-catalog", "native-cache-isolation", "profile-launch", "interrupt-trust-identity"] });
}
export const profileNativeCatalogFixture = JSON.stringify({ cgw: "native-cache-sentinel", models: [{ slug: "native-fixture", display_name: "Native fixture", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high", description: "High" }], tool_mode: "function", priority: 1, multi_agent_version: "v2", context_window: 256000 }] });
