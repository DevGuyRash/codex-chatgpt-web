import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProfileCapabilities, probeCodexProfileCapabilities } from "../src/codex-profile-capabilities";
import { resolveIntegrationTarget } from "../src/codex-integration-target";
import { unitProfileCapabilityFixture } from "./fixtures/profile-integration";

test("profile capability gate rejects missing and changed binary evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-capability-gate-"));
  try {
    const target = resolveIntegrationTarget({ codexHome: join(root, "codex"), runtimeRoot: join(root, "runtime"), profile: "work" });
    expect(() => assertProfileCapabilities(target)).toThrow("capability check");
    unitProfileCapabilityFixture(target, root);
    expect(assertProfileCapabilities(target).capabilities).toContain("profile-catalog");
    writeFileSync(join(root, "unit-codex-binary"), "changed");
    expect(() => assertProfileCapabilities(target)).toThrow("stale");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("supported Codex binary proves precedence, catalog isolation, launch and positive/negative hook trust offline", async () => {
  const result = await probeCodexProfileCapabilities(process.env.CODEX_TEST_PROFILE_BINARY!);
  expect(result.capabilities).toHaveLength(5);
  expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
}, 60_000);
