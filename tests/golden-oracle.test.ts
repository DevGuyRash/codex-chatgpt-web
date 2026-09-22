import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorkload, materializeWorkload } from "../scripts/golden/workloads";
import { runProjectOracle, verifyArtifactCommit } from "../scripts/golden/oracle";
import { tmpdir } from "node:os";
import { goldenNativeEnvironment } from "../scripts/golden/runtime-config";

test("artifact acceptance rejects ignored output and hidden worktree changes despite clean Git status", () => {
  const root = mkdtempSync(join(tmpdir(), "golden-commit-"));
  const env = goldenNativeEnvironment(root, join(root, "native"), "/usr/bin/git");
  const git = (...args: string[]) => { const result = Bun.spawnSync(["/usr/bin/git", "-C", root, ...args], { env, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  try {
    git("init", "-q"); git("config", "user.name", "Golden Fixture"); git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null");
    writeFileSync(join(root, ".gitignore"), "output.txt\n"); git("add", ".gitignore"); git("commit", "-qm", "Input baseline");
    const baseline = git("rev-parse", "HEAD");
    writeFileSync(join(root, "output.txt"), "required artifact\n"); writeFileSync(join(root, "README.md"), "Unrelated change\n"); git("add", "README.md"); git("commit", "-qm", "Unrelated commit");
    const check = () => verifyArtifactCommit({ repository: root, baseline, paths: ["output.txt"], env });
    expect(git("status", "--porcelain")).toBe("");
    expect(check()).toMatchObject({ passed: false, clean: true });
    git("add", "-f", "output.txt"); git("commit", "-qm", "Required artifact");
    expect(check()).toMatchObject({ passed: true, clean: true });
    git("update-index", "--assume-unchanged", "output.txt"); writeFileSync(join(root, "output.txt"), "uncommitted hidden change\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(check()).toMatchObject({ passed: false, clean: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("the independent project runs on new input with native write and network restrictions", async () => {
  const parent = resolve("context/golden/oracle-tests"); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, "run-")), work = join(root, "work");
  const workload = createWorkload({ level: 3, seed: "native-oracle", batch: 0 });
  materializeWorkload(work, workload);
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { hits++; return new Response("reachable"); } });
  writeFileSync(join(work, "project/analyze.ts"), `import {readFileSync,writeFileSync} from "node:fs";import {join} from "node:path";
let writeAllowed=false,networkAllowed=false;
try{writeFileSync("forbidden-output","unexpected");writeAllowed=true}catch{}
try{await fetch("http://127.0.0.1:${server.port}",{signal:AbortSignal.timeout(1000)});networkAllowed=true}catch{}
console.log(JSON.stringify({datasetId:process.argv[3],count:JSON.parse(readFileSync(join(process.argv[2],"orders.json"),"utf8")).length,writeAllowed,networkAllowed}));
`);
  try {
    const result = await runProjectOracle({ workload, work, validationRoot: join(root, "validation"), nativeHome: join(root, "native-home"), nativeExecutable: process.env.CODEX_TEST_PROFILE_BINARY!, bunExecutable: process.execPath,
      onValidation: () => {}, onLaunch: () => {}, onOutput: () => {} });
    expect(result.validationWorkload.id).not.toBe(workload.id);
    expect(JSON.parse(result.stdout)).toEqual({ datasetId: result.validationWorkload.id, count: 1500, writeAllowed: false, networkAllowed: false });
    expect(result.exit).toEqual({ code: 0, signal: null });
    expect(hits).toBe(0);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 15000);
