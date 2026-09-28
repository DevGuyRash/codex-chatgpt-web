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
    mkdirSync(join(root, "launcher/scripts"), { recursive: true }); mkdirSync(join(root, "launcher/patches"), { recursive: true }); mkdirSync(join(root, "native/electron"), { recursive: true });
    writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "scripts/golden/main.ts"), "export const acceptance = true;\n");
    writeFileSync(join(root, "launcher/scripts/native-electron.cjs"), "module.exports = {};\n");
    writeFileSync(join(root, "launcher/patches/extension-adapter.patch"), "reviewed adapter patch\n");
    writeFileSync(join(root, "native/electron/webauthn.patch"), "reviewed patch\n");
    const deployed = join(root, "helper.cjs"); writeFileSync(deployed, "one");
    const before = goldenImplementationIdentity(root, [deployed]);
    writeFileSync(join(root, "README.md"), "Unrelated documentation\n");
    expect(goldenImplementationIdentity(root, [deployed]).sha256).toBe(before.sha256);
    writeFileSync(join(root, "src/main.ts"), "export const value = 2;\n");
    const sourceChange = goldenImplementationIdentity(root, [deployed]);
    expect(sourceChange.sha256).not.toBe(before.sha256);
    writeFileSync(deployed, "two");
    const artifactChange = goldenImplementationIdentity(root, [deployed]);
    expect(artifactChange.sha256).not.toBe(sourceChange.sha256);
    expect(before.records.map(record => record.name)).toContain("scripts/golden/main.ts");
    expect(before.records.map(record => record.name)).toContain("launcher/scripts/native-electron.cjs");
    expect(before.records.map(record => record.name)).toContain("launcher/patches/extension-adapter.patch");
    expect(before.records.map(record => record.name)).toContain("native/electron/webauthn.patch");
    writeFileSync(join(root, "native/electron/webauthn.patch"), "updated patch\n");
    expect(goldenImplementationIdentity(root, [deployed]).sha256).not.toBe(artifactChange.sha256);
    const nativePatchChange = goldenImplementationIdentity(root, [deployed]);
    writeFileSync(join(root, "launcher/patches/extension-adapter.patch"), "updated adapter patch\n");
    expect(goldenImplementationIdentity(root, [deployed]).sha256).not.toBe(nativePatchChange.sha256);
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
