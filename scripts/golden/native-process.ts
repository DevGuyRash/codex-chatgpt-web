import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync } from "node:fs";
import type { Readable } from "node:stream";
import { ownedProcessIdentity, ownsProcess, type OwnedProcess } from "./workspace";
import { DiagnosticError } from "../../src/diagnostics/problems";

export class NativeRpcError extends DiagnosticError {
  constructor(message: string, code: string, readonly uncertain = false, readonly rpcCode?: number, exit?: NativeExit) {
    super({ code, message, origin: "golden-native", retryable: false, recovery: "unknown", actions: ["open-diagnostics", "export-logs"],
      ...(exit ? { ...(exit.code !== null ? { exitCode: exit.code } : {}), signal: exit.signal } : {}),
    });
    this.name = "NativeRpcError";
  }
}
export interface NativeExit { code: number | null; signal: NodeJS.Signals | null }

/** Cleanup can fail independently; bounded traversal preserves the observed native failure. */
export function findNativeFailure<T extends Error>(error: unknown, matches: (value: Error) => value is T): T | undefined {
  const pending = [error], seen = new Set<unknown>();
  while (pending.length && seen.size < 32) {
    const value = pending.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    if (value instanceof Error && matches(value)) return value;
    if (value instanceof AggregateError) pending.push(...value.errors.slice(0, 32));
    if (value instanceof Error && value.cause) pending.push(value.cause);
  }
}

/** One kernel-identified detached process group shared by the native JSONL drivers. */
export class OwnedNativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly identity?: OwnedProcess;
  readonly result: Promise<NativeExit>;
  private readonly members = new Map<number, OwnedProcess>();
  private readonly exited: Promise<NativeExit>;
  private failure?: Error;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    stdout(stream: Readable): Promise<void>; stderr(stream: Readable): Promise<void>; onFailure(error: Error): void;
  }) {
    if (process.platform !== "linux") throw new Error("Golden native process ownership currently requires Linux");
    this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.identity = this.child.pid ? ownedProcessIdentity(this.child.pid) : undefined;
    if (this.identity) this.members.set(this.identity.pid, this.identity);
    this.exited = new Promise(resolve => {
      this.child.once("error", error => { this.fail(error); resolve({ code: null, signal: null }); });
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this.child.stdin.on("error", error => this.fail(error));
    const stdout = options.stdout(this.child.stdout).catch(error => this.fail(error));
    const stderr = options.stderr(this.child.stderr).catch(error => this.fail(error));
    this.result = Promise.all([stdout, stderr, this.exited]).then(([, , exit]) => { if (this.failure) throw this.failure; return exit; });
    void this.result.catch(() => {});
  }
  private fail(value: unknown): void {
    if (this.failure) return;
    this.failure = value instanceof Error ? value : new NativeRpcError("Native process stream failed", "native_protocol_invalid", true);
    this.options.onFailure(this.failure); this.signal("SIGTERM");
  }
  private rememberMembers(): void {
    if (!this.identity || !ownsProcess(this.identity)) return;
    for (const name of readdirSync("/proc")) if (/^\d+$/.test(name)) {
      try {
        const candidate = ownedProcessIdentity(Number(name));
        if (candidate?.group === this.identity.group) this.members.set(candidate.pid, candidate);
      } catch (error) { if (!["EACCES", "EPERM", "ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
  }
  signal(signal: NodeJS.Signals): void {
    this.rememberMembers();
    // Snapshot members before closing stdin: a tool child can outlive its parent
    // while retaining inherited pipes. A member's kernel start identity pins ownership.
    const liveMember = [...this.members.values()].some(known => {
      const actual = ownedProcessIdentity(known.pid);
      return actual?.start === known.start && actual.group === known.group;
    });
    if (this.identity && liveMember) {
      try { process.kill(-this.identity.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
  close(graceMs = 5000): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.rememberMembers(); this.child.stdin.end();
      const waitForExit = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([this.exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
        finally { if (timer) clearTimeout(timer); }
      };
      if (!await waitForExit(graceMs)) { this.signal("SIGTERM"); if (!await waitForExit(1000)) this.signal("SIGKILL"); }
      this.signal("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.result.then(() => {}, () => {}), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          this.signal("SIGKILL"); this.child.stdout.destroy(); this.child.stderr.destroy();
          reject(new NativeRpcError("Owned native process or its pipes did not settle", "native_cleanup_incomplete", true));
        }, 2000); })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.closing;
  }
}
