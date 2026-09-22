import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ownedProcessIdentity, verifyStoppedGoldenLauncher } from "../scripts/golden/workspace";

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
