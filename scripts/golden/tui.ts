import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as wait } from "node:timers/promises";
import type { Readable } from "node:stream";
import { isProGeneration } from "../../src/campaign-policy";
import type { ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { NativeRpcError, OwnedNativeProcess } from "./native-process";
import { ownedProcessIdentity, ownsProcess, type OwnedProcess } from "./workspace";
import type { OwnedNativeSocketIdentity } from "./native-socket";
import { goldenArtifactWritableRoots } from "./runtime-config";

interface TuiOptions {
  root: string; cwd: string; nativeExecutable: string; tmuxExecutable: string; env: NodeJS.ProcessEnv;
  route: ChatGptWebModelRoute; modelProvider?: string; artifactRepository?: string;
  onSnapshot(text: string): void | Promise<void>;
  onInput(text: string): void | Promise<void>;
  onTransport(stream: "stdout" | "stderr", text: string): void | Promise<void>;
  onLaunch(identities: { appServer: OwnedProcess; tmux: OwnedProcess; pane: OwnedProcess }): void | Promise<void>;
}

/** A private tmux server and private native app-server; no desktop app or shared terminal is attached. */
export class GoldenTui {
  private native!: OwnedNativeProcess;
  private serverIdentity?: OwnedProcess;
  private paneIdentity?: OwnedProcess;
  private socketInode?: number;
  private controlInode?: number;
  private ended = false;
  private closing?: Promise<void>;
  private readonly socket: string;
  private readonly control: string;
  private constructor(private readonly options: TuiOptions) {
    this.socket = join(options.root, "tmux.sock"); this.control = join(options.root, "native.sock");
  }
  private tmux(args: string[], starting = false): string {
    if (!starting) this.assertOwned();
    const result = Bun.spawnSync([this.options.tmuxExecutable, "-f", "/dev/null", "-S", this.socket, ...args], { cwd: this.options.cwd, env: { ...this.options.env, TERM: "xterm-256color" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    if (result.exitCode !== 0) throw new NativeRpcError(`Owned tmux command failed: ${result.stderr.toString("utf8").slice(0, 2048)}`, "native_tui_unavailable", true);
    if (result.stdout.byteLength > 4 * 1024 * 1024) throw new NativeRpcError("Native terminal snapshot exceeded its bound", "native_protocol_too_large", true);
    return result.stdout.toString("utf8");
  }
  private assertOwned(): void {
    if (this.ended || !this.serverIdentity || !ownsProcess(this.serverIdentity) || !existsSync(this.socket)) throw new NativeRpcError("Private terminal ownership is unavailable", "native_tui_ownership_missing", true);
    const stat = lstatSync(this.socket);
    if (!stat.isSocket() || stat.ino !== this.socketInode) throw new NativeRpcError("Private terminal socket identity changed", "native_tui_ownership_missing", true);
  }
  static async start(optionsInput: TuiOptions): Promise<GoldenTui> {
    if (isProGeneration(optionsInput.route) || optionsInput.route.interactionMode !== "automatic") throw new Error("Golden TUI requires a permitted non-Pro automatic route");
    const options = { ...optionsInput, root: resolve(optionsInput.root), cwd: resolve(optionsInput.cwd) };
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.modelProvider ?? "openai")) throw new Error("Native provider requires its configured identifier");
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    if (realpathSync(options.root) !== options.root || realpathSync(options.cwd) !== options.cwd) throw new Error("Native terminal requires real owned directories");
    const tui = new GoldenTui(options);
    if (Buffer.byteLength(tui.control) >= 104 || Buffer.byteLength(tui.socket) >= 104) throw new Error("Native terminal requires a shorter private socket directory");
    if (existsSync(tui.control) || existsSync(tui.socket)) throw new Error("A prior native terminal scope needs settlement before reuse");
    const artifactConfig = options.artifactRepository ? ["-c", `sandbox_workspace_write.writable_roots=${JSON.stringify(goldenArtifactWritableRoots(options.artifactRepository))}`] : [];
    const nativeConfig = ["-c", `model=${JSON.stringify(options.route.slug)}`, "-c", `model_provider=${JSON.stringify(options.modelProvider ?? "openai")}`, "-c", `model_reasoning_effort=${JSON.stringify(options.route.codexEffort)}`, "-c", `plan_mode_reasoning_effort=${JSON.stringify(options.route.codexEffort)}`, ...artifactConfig];
    const read = async (stream: Readable, name: "stdout" | "stderr") => {
      const decoder = new StringDecoder("utf8");
      for await (const chunk of stream) { const text = decoder.write(Buffer.from(chunk)); if (text) await options.onTransport(name, text); }
      const text = decoder.end(); if (text) await options.onTransport(name, text);
    };
    tui.native = new OwnedNativeProcess({ executable: options.nativeExecutable, args: ["app-server", "--listen", `unix://${tui.control}`, ...nativeConfig], cwd: options.cwd, env: options.env,
      stdout: stream => read(stream, "stdout"), stderr: stream => read(stream, "stderr"), onFailure: () => {} });
    let exited = false; void tui.native.result.then(() => { exited = true; }, () => { exited = true; });
    try {
      const deadline = Date.now() + 15000;
      while (!existsSync(tui.control)) {
        if (exited || Date.now() > deadline) throw new NativeRpcError("Private native control socket did not become ready", "native_tui_unavailable");
        await wait(50);
      }
      if (!lstatSync(tui.control).isSocket()) throw new Error("Native control endpoint is not a private socket");
      tui.controlInode = lstatSync(tui.control).ino;
      const pid = Number(tui.tmux(["new-session", "-d", "-P", "-F", "#{pid}", "-s", "golden", "-x", "120", "-y", "40", "-c", options.cwd, "--", options.nativeExecutable,
        "--remote", `unix://${tui.control}`, "--no-alt-screen", ...nativeConfig, "--sandbox", "workspace-write", "--ask-for-approval", "never"], true).trim());
      tui.serverIdentity = ownedProcessIdentity(pid); tui.socketInode = lstatSync(tui.socket).ino;
      tui.assertOwned();
      tui.paneIdentity = ownedProcessIdentity(Number(tui.tmux(["display-message", "-p", "-t", "golden:0.0", "#{pane_pid}"]).trim()));
      if (!tui.native.identity) throw new Error("Native app-server process identity is unavailable");
      if (!tui.paneIdentity) throw new Error("Native terminal process identity is unavailable");
      await options.onLaunch({ appServer: tui.native.identity, tmux: tui.serverIdentity!, pane: tui.paneIdentity });
      return tui;
    } catch (error) { await tui.close(); throw error; }
  }
  async snapshot(): Promise<string> {
    const text = this.tmux(["capture-pane", "-p", "-J", "-S", "-10000", "-t", "golden:0.0"]);
    await this.options.onSnapshot(text); return text;
  }
  waitForReady(options: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    return this.waitForView(text => [...text.matchAll(/model:\s+([^\s│]+)\s+([^\s│]+)/g)].at(-1)?.slice(1).join(" ") === `${this.options.route.slug} ${this.options.route.codexEffort}`, options);
  }
  controlIdentity(): OwnedNativeSocketIdentity {
    this.assertOwned();
    const owner = this.native.identity;
    if (!owner || !ownsProcess(owner) || this.controlInode === undefined || lstatSync(this.control).ino !== this.controlInode) throw new NativeRpcError("Private native control endpoint ownership changed", "native_tui_ownership_missing", true);
    return { path: this.control, inode: this.controlInode, owner: { ...owner } };
  }
  async waitForView(predicate: (text: string) => boolean, options: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    const deadline = performance.now() + options.timeoutMs;
    for (;;) {
      options.signal?.throwIfAborted();
      const text = this.tmux(["capture-pane", "-p", "-J", "-S", "-10000", "-t", "golden:0.0"]);
      if (predicate(text)) { await this.options.onSnapshot(text); return text; }
      if (performance.now() >= deadline) { await this.options.onSnapshot(text); throw new NativeRpcError("Native terminal did not display the required state", "native_tui_state_missing", true); }
      await wait(100, undefined, { signal: options.signal });
    }
  }
  async submit(text: string): Promise<void> {
    this.assertOwned();
    if (!text.trim() || Buffer.byteLength(text) > 1024 * 1024) throw new Error("Native terminal input must be nonempty and bounded");
    await this.options.onInput(text); this.assertOwned();
    const path = join(this.options.root, `${randomUUID()}.input`), name = `golden-${randomUUID()}`;
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    try {
      this.tmux(["load-buffer", "-b", name, path]);
      this.tmux(["paste-buffer", "-p", "-d", "-b", name, "-t", "golden:0.0"]);
      this.tmux(["send-keys", "-t", "golden:0.0", "Enter"]);
    } finally { unlinkSync(path); }
  }
  key(key: "Enter" | "Escape" | "Up" | "Down" | "C-c" | "C-d" | "Tab"): void {
    this.tmux(["send-keys", "-t", "golden:0.0", key]);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        if (this.serverIdentity && ownsProcess(this.serverIdentity)) {
          try { this.tmux(["kill-server"]); } catch (error) { if (ownsProcess(this.serverIdentity)) throw error; }
        }
      } finally {
        this.ended = true;
        try { await this.native?.close(100); }
        finally {
          const members = [this.paneIdentity, this.serverIdentity].filter((value): value is OwnedProcess => Boolean(value));
          const same = (known: OwnedProcess) => { const actual = ownedProcessIdentity(known.pid); return actual?.start === known.start && actual.executable === known.executable; };
          const deadline = performance.now() + 2000;
          while (members.some(same) && performance.now() < deadline) {
            for (const known of members) if (same(known)) {
              try { process.kill(known.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
            await wait(25);
          }
          if (members.some(same)) throw new NativeRpcError("Owned terminal processes did not settle", "native_cleanup_incomplete", true);
        }
      }
    })();
    return this.closing;
  }
}
