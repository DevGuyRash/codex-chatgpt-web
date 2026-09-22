import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goldenImplementationIdentity, verifyGoldenBrowserHelper } from "../scripts/golden/implementation";

test("campaign identity covers uncommitted executable changes and the selected deployed artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-implementation-"));
  try {
    expect(spawnSync("git", ["-C", root, "init", "-q"]).status).toBe(0);
    mkdirSync(join(root, "src")); mkdirSync(join(root, "scripts/golden"), { recursive: true });
    writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "scripts/golden/main.ts"), "export const acceptance = true;\n");
    const deployed = join(root, "helper.cjs"); writeFileSync(deployed, "one");
    const before = goldenImplementationIdentity(root, [deployed]);
    writeFileSync(join(root, "README.md"), "Unrelated documentation\n");
    expect(goldenImplementationIdentity(root, [deployed]).sha256).toBe(before.sha256);
    writeFileSync(join(root, "src/main.ts"), "export const value = 2;\n");
    const sourceChange = goldenImplementationIdentity(root, [deployed]);
    expect(sourceChange.sha256).not.toBe(before.sha256);
    writeFileSync(deployed, "two");
    expect(goldenImplementationIdentity(root, [deployed]).sha256).not.toBe(sourceChange.sha256);
    expect(before.records.map(record => record.name)).toContain("scripts/golden/main.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live helper verification compares the canonical build before accepting a deployed artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-helper-identity-"));
  const repository = join(import.meta.dir, ".."), helper = join(root, "browser-helper.cjs");
  try {
    const build = spawnSync(process.execPath, ["run", join(repository, "scripts/build-browser-helper.ts"), helper], { cwd: repository, encoding: "utf8", timeout: 30000 });
    expect(build.status).toBe(0);
    expect(verifyGoldenBrowserHelper(repository, helper).sha256).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(helper, "stale helper");
    expect(() => verifyGoldenBrowserHelper(repository, helper)).toThrow("browser helper does not match");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
