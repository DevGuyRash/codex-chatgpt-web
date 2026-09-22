import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { containsPath } from "../../src/diagnostics/paths";
import { createWorkload, materializeWorkload, type GoldenWorkload } from "./workloads";
import { NativeRpcError, OwnedNativeProcess } from "./native-process";
import type { OwnedProcess } from "./workspace";

/** A clean worktree alone can hide ignored or assume-unchanged outputs. Check committed bytes. */
export function verifyArtifactCommit(input: { repository: string; baseline: string; paths: readonly string[]; env: NodeJS.ProcessEnv }) {
  const repository = resolve(input.repository), failures: string[] = [];
  if (realpathSync(repository) !== repository || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(input.baseline) || !input.paths.length) throw new Error("Artifact commit verification requires its canonical repository, baseline and required paths");
  const git = (...args: string[]) => spawnSync("git", ["-C", repository, ...args], { env: input.env, timeout: 15000, maxBuffer: 20 * 1024 * 1024 });
  const headResult = git("rev-parse", "HEAD"), head = headResult.stdout.toString("utf8").trim();
  if (headResult.status !== 0 || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(head)) throw new Error("Artifact repository HEAD could not be read");
  if (head === input.baseline || git("merge-base", "--is-ancestor", input.baseline, head).status !== 0) failures.push("Artifact commit does not advance its recorded baseline");
  const status = git("status", "--porcelain"), clean = status.status === 0 && !status.stdout.length;
  if (!clean) failures.push("Artifact repository has uncommitted changes or unavailable status");
  for (const path of new Set(input.paths)) {
    const file = resolve(repository, path);
    if (!path || path.startsWith("/") || !containsPath(repository, file) || realpathSync(file) !== file) throw new Error("Required artifact path is outside its canonical repository");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("Required artifact is aliased, oversized or not a regular file");
    const committed = git("show", `${head}:${path}`);
    if (committed.status !== 0 || !committed.stdout.equals(readFileSync(file))) failures.push(`Required artifact differs from the recorded commit: ${path}`);
  }
  return { passed: !failures.length, failures, baseline: input.baseline, head, clean };
}

/** Execute the produced CLI on independent input; artifact/commit acceptance remains with the caller. */
export async function runProjectOracle(options: {
  workload: GoldenWorkload; work: string; validationRoot: string; nativeHome: string; nativeExecutable: string; bunExecutable: string;
  timeoutMs?: number; signal?: AbortSignal;
  onValidation(workload: GoldenWorkload): void | Promise<void>;
  onLaunch(identity: OwnedProcess): void | Promise<void>;
  onOutput(stream: "stdout" | "stderr", text: string): void | Promise<void>;
}) {
  options.signal?.throwIfAborted();
  if (options.workload.level < 3) throw new Error("This workload does not require reusable project verification");
  const work = resolve(options.work), validationRoot = resolve(options.validationRoot), nativeHome = resolve(options.nativeHome);
  if (realpathSync(work) !== work || containsPath(work, validationRoot) || containsPath(work, nativeHome)) throw new Error("Independent native validation requires separate owned directories");
  const project = join(work, "project/analyze.ts"), stat = lstatSync(project);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024 || !containsPath(work, realpathSync(project))) throw new Error("Generated project entry point is missing, oversized or aliased");
  const sourceSha256 = createHash("sha256").update(readFileSync(project)).digest("hex");
  mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
  if (realpathSync(nativeHome) !== nativeHome || readdirSync(nativeHome).length) throw new Error("Independent validation requires a new empty native home");
  const validationWorkload = createWorkload({ level: options.workload.level, batch: options.workload.batch, seed: `${options.workload.id}:independent:${randomUUID()}` });
  materializeWorkload(validationRoot, validationWorkload);
  await options.onValidation(validationWorkload); options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Native validation requires a finite deadline");
  let stdout = "", stderr = "";
  const read = async (stream: Readable, name: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8"); let bytes = 0;
    const append = async (text: string) => { if (name === "stdout") stdout += text; else stderr += text; await options.onOutput(name, text); };
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > (name === "stdout" ? 1024 * 1024 : 64 * 1024)) throw new NativeRpcError("Native project validation exceeded its output bound", "oracle_output_too_large");
      const text = decoder.write(Buffer.from(chunk)); if (text) await append(text);
    }
    const text = decoder.end(); if (text) await append(text);
  };
  const native = new OwnedNativeProcess({ executable: options.nativeExecutable,
    args: ["sandbox", "--permission-profile", ":read-only", "--cd", work, "--", options.bunExecutable, project, join(validationRoot, "input"), validationWorkload.id], cwd: work,
    env: { PATH: [dirname(options.bunExecutable), dirname(options.nativeExecutable), "/usr/bin", "/bin"].join(":"), HOME: nativeHome, CODEX_HOME: nativeHome },
    stdout: stream => read(stream, "stdout"), stderr: stream => read(stream, "stderr"), onFailure: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined, aborted: (() => void) | undefined, stopped: NativeRpcError | undefined, failure: unknown;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const stop = (code: string) => { stopped ??= new NativeRpcError("Native project validation did not settle within its observation boundary", code, true); native.signal("SIGTERM"); reject(stopped); };
    timer = setTimeout(() => stop("oracle_timeout"), timeoutMs);
    aborted = () => stop("native_observation_cancelled"); options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
  });
  void interrupted.catch(() => {});
  try {
    const exit = await Promise.race([interrupted, (async () => {
      if (!native.identity) throw new NativeRpcError("Native validation process ownership is unavailable", "native_process_ownership_missing");
      await options.onLaunch(native.identity); if (stopped) throw stopped;
      native.child.stdin.end(); return await native.result;
    })()]);
    if (exit.code !== 0 || exit.signal !== null) throw new NativeRpcError(`Native project validation failed (${exit.signal ?? exit.code}): ${stderr}`, "oracle_execution_failed");
    if (createHash("sha256").update(readFileSync(project)).digest("hex") !== sourceSha256) throw new NativeRpcError("Generated project changed during independent validation", "oracle_source_changed");
    return { validationWorkload, stdout, stderr, exit, sourceSha256 };
  } catch (error) { failure = error; throw error; }
  finally {
    if (timer) clearTimeout(timer); if (aborted) options.signal?.removeEventListener("abort", aborted);
    try { await native.close(100); } catch (error) { if (error instanceof Error && failure) error.cause = failure; throw error; }
  }
}
