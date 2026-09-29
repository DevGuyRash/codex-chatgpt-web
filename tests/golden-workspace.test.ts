import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedProcessIdentity, requestIdleGoldenLauncherShutdown, startGoldenWorkspace, stopGoldenWorkspace, stopOwnedProcessGroup, verifyStoppedGoldenLauncher } from "../scripts/golden/workspace";

test("idle launcher recovery retries only a typed no-effect busy refusal", async () => {
  let attempts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(++attempts < 3 ? { error: "launcher_busy" } : { ok: true }, { status: attempts < 3 ? 409 : 200 }) });
  try {
    await requestIdleGoldenLauncherShutdown({ endpoint: `http://127.0.0.1:${server.port}`, token: "fixture" }, () => true, 5, 1000);
    expect(attempts).toBe(3);
  } finally { server.stop(true); }
  let rejected = 0;
  const failed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { rejected++; return Response.json({ error: "shutdown_failed" }, { status: 409 }); } });
  try {
    await expect(requestIdleGoldenLauncherShutdown({ endpoint: `http://127.0.0.1:${failed.port}`, token: "fixture" }, () => true, 5, 1000)).rejects.toMatchObject({ code: "golden_launcher_shutdown_refused", problem: { findings: [{ message: "controlStatus=409; controlReason=shutdown_failed" }] } });
    expect(rejected).toBe(1);
  } finally { failed.stop(true); }
});

test.skipIf(process.platform !== "linux")("golden workspace rejects stock Electron before creating a hidden display", async () => {
  const parent = mkdtempSync(join(tmpdir(), "codex-golden-reviewed-electron-"));
  const root = join(parent, "workspace");
  const previous = process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE;
  try {
    delete process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE;
    await expect(startGoldenWorkspace(root)).rejects.toThrow("Set CODEX_WEB_GPT_ELECTRON_EXECUTABLE");
    expect(existsSync(root)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_ELECTRON_EXECUTABLE = previous;
    rmSync(parent, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("launcher recovery requires the recorded process and its whole group to have stopped", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    const prior = ownedProcessIdentity(child.pid!)!;
    expect(prior.group).toBe(prior.pid);
    expect(() => verifyStoppedGoldenLauncher(prior)).toThrow("not fully stopped");
    expect(() => verifyStoppedGoldenLauncher({ ...prior, start: "0" })).toThrow("not fully stopped");
    child.kill("SIGTERM"); await closed;
    expect(() => verifyStoppedGoldenLauncher(prior)).not.toThrow();
    expect(() => verifyStoppedGoldenLauncher({ ...prior, group: prior.pid + 1 })).toThrow("not fully stopped");
  } finally { child.kill("SIGTERM"); await closed; }
});

test.skipIf(process.platform !== "linux")("a surviving helper prevents recovery even after its launcher leader exits", async () => {
  const script = `const { spawn } = await import("node:child_process"); const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); helper.once("spawn", () => { console.log("ready"); process.stdin.resume(); process.stdin.once("data", () => process.exit(0)); });`;
  const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = once(child, "close");
  let group: number | undefined;
  try {
    await once(child.stdout, "data");
    const prior = ownedProcessIdentity(child.pid!)!; group = prior.group;
    child.stdin.write("exit"); await closed;
    expect(ownedProcessIdentity(prior.pid)).toBeUndefined();
    expect(() => verifyStoppedGoldenLauncher(prior)).toThrow("surviving members");
  } finally {
    if (group) { try { process.kill(-group, "SIGTERM"); } catch {} }
    child.kill("SIGTERM"); await closed;
  }
});

test.skipIf(process.platform !== "linux")("owned workspace shutdown stops only the recorded process group", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    await once(child, "spawn");
    const owner = ownedProcessIdentity(child.pid!)!;
    await expect(stopOwnedProcessGroup({ ...owner, start: "stale" }, 100)).rejects.toThrow("different owner");
    expect(ownedProcessIdentity(child.pid!)).toMatchObject(owner);
    await stopOwnedProcessGroup(owner, 2_000);
    await closed;
    expect(ownedProcessIdentity(child.pid!)).toBeUndefined();
  } finally { child.kill("SIGTERM"); await closed; }
});

test.skipIf(process.platform !== "linux")("stopped workspace shutdown preserves its profile and campaign record", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-golden-stopped-"));
  const owner = { pid: 8_000_000, group: 8_000_000, start: "old", executable: "/missing" };
  const statePath = join(root, "workspace.json");
  const state = { version: 1, root, codexHome: join(root, "codex"), runtimeHome: join(root, "runtime"), launcherData: join(root, "launcher"), descriptorPath: join(root, "runtime/runtime/launcher-browser.json"), processes: { launcher: owner, display: owner, "viewer-socket": owner, viewer: owner } };
  try {
    writeFileSync(statePath, JSON.stringify(state));
    await stopGoldenWorkspace(root);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(state);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
