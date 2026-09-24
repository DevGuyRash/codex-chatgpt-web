import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { NativeRpcError } from "./native-process";
import { ownsProcess, type OwnedProcess } from "./workspace";

export interface OwnedNativeSocketIdentity {
  path: string; inode: number; owner: OwnedProcess;
  linkInode?: number; targetPath?: string; kernelInode?: string;
}

/** Current native app-server may publish a private symlink to its owned hashed Unix socket. */
export function inspectOwnedNativeSocket(path: string, owner: OwnedProcess): OwnedNativeSocketIdentity {
  if (!isAbsolute(path) || resolve(path) !== path || !ownsProcess(owner)) throw new Error("Native socket owner or path is invalid");
  const uid = process.getuid?.();
  const privateDirectory = (directoryPath: string) => {
    const directory = lstatSync(directoryPath);
    return directory.isDirectory() && directory.uid === uid && (directory.mode & 0o077) === 0
      && realpathSync(directoryPath) === directoryPath;
  };
  if (!privateDirectory(dirname(path))) throw new Error("Native socket request directory is not private");
  const endpoint = lstatSync(path);
  if (endpoint.isSocket() && endpoint.uid === uid) return { path, inode: endpoint.ino, owner };
  if (!endpoint.isSymbolicLink() || endpoint.uid !== uid) throw new Error("Native endpoint is neither an owned socket nor an owned link");
  const targetPath = readlinkSync(path);
  if (!isAbsolute(targetPath) || resolve(targetPath) !== targetPath || realpathSync(path) !== targetPath
    || !privateDirectory(dirname(targetPath))) throw new Error("Native socket link leaves its owned private target");
  const target = lstatSync(targetPath);
  if (!target.isSocket() || target.uid !== uid) throw new Error("Native socket link target is not an owned socket");
  const rows = readFileSync(`/proc/${owner.pid}/net/unix`, "utf8").split("\n").slice(1)
    .map(line => line.trim().split(/\s+/)).filter(fields => fields.length >= 8
      && fields[3] === "00010000" && fields[5] === "01" && fields.slice(7).join(" ") === targetPath);
  const fds = new Set(readdirSync(`/proc/${owner.pid}/fd`).flatMap(fd => {
    try { return [readlinkSync(`/proc/${owner.pid}/fd/${fd}`)]; }
    catch { return []; }
  }));
  const kernelInode = rows.map(fields => fields[6]!).find(inode => fds.has(`socket:[${inode}]`));
  if (!kernelInode) throw new Error("Native socket target is not held by its recorded process");
  return { path, inode: target.ino, owner, linkInode: endpoint.ino, targetPath, kernelInode };
}

/** Observe an exact private native endpoint; closing this client never stops its owning server. */
export class OwnedNativeSocket {
  private readonly socket: Bun.WebSocket;
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private received: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closing?: Promise<void>;
  private queuedBytes = 0;
  private queuedFrames = 0;
  private readonly maximum: number;
  constructor(private readonly options: {
    identity: OwnedNativeSocketIdentity;
    onMessage(text: string): Promise<void>;
    onFailure(error: Error): void;
    maxFrameBytes?: number;
  }) {
    this.maximum = options.maxFrameBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 64 * 1024 * 1024) throw new Error("Native socket frame limits must be bounded positive integers");
    this.assertOwned();
    // Bun offers compression by default; the installed native Unix endpoint rejects
    // the extension header. This socket carries JSON text with compression disabled.
    const Socket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => Bun.WebSocket;
    this.socket = new Socket(`ws+unix://${options.identity.path}:/`, { perMessageDeflate: false });
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => { try { this.assertOwned(); resolve(); } catch (error) { reject(error); this.fail(error); } }, { once: true });
      this.socket.addEventListener("error", () => reject(new NativeRpcError("Owned native socket connection failed", "native_socket_unavailable", true)), { once: true });
      this.socket.addEventListener("close", () => reject(new NativeRpcError("Owned native socket closed before readiness", "native_socket_closed", true)), { once: true });
    });
    void this.ready.catch(error => this.fail(error));
    this.ended = new Promise(resolve => this.socket.addEventListener("close", () => {
      resolve();
      if (!this.closing) this.fail(new NativeRpcError("Owned native socket closed before further protocol work could settle", "native_socket_closed", true));
    }, { once: true }));
    this.socket.addEventListener("error", () => this.fail(new NativeRpcError("Owned native socket transport failed", "native_socket_unavailable", true)));
    this.socket.addEventListener("message", event => {
      if (this.failure || this.closing) return;
      const data: unknown = (event as unknown as { data: unknown }).data;
      if (typeof data !== "string") { this.fail(new NativeRpcError("Native socket emitted a non-text frame", "native_protocol_invalid", true)); return; }
      const text = data, bytes = Buffer.byteLength(text);
      if (bytes > this.maximum || this.queuedBytes + bytes > this.maximum * 2 || this.queuedFrames >= 1024) {
        this.fail(new NativeRpcError("Native socket capture backlog exceeded its bound", "native_protocol_too_large", true)); return;
      }
      this.queuedBytes += bytes; this.queuedFrames++;
      this.received = this.received.then(async () => {
        if (!this.failure) await options.onMessage(text);
      }).catch(error => this.fail(error)).finally(() => { this.queuedBytes -= bytes; this.queuedFrames--; });
    });
  }
  get pid(): number { return this.options.identity.owner.pid; }
  private assertOwned(): void {
    try { this.inspectOwnership(); }
    catch { throw new NativeRpcError("Private native socket ownership changed", "native_tui_ownership_missing", true); }
  }
  private inspectOwnership(): void {
    const identity = this.options.identity;
    const current = inspectOwnedNativeSocket(identity.path, identity.owner);
    if (current.inode !== identity.inode || current.linkInode !== identity.linkInode
      || current.targetPath !== identity.targetPath || current.kernelInode !== identity.kernelInode) {
      throw new NativeRpcError("Private native socket ownership changed", "native_tui_ownership_missing", true);
    }
  }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new NativeRpcError("Native socket failed without a typed error", "native_socket_unavailable", true);
    this.socket?.terminate(); this.options.onFailure(this.failure);
  }
  abort(): void { this.socket.terminate(); }
  async send(text: string, stillPending?: () => boolean): Promise<void> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closing) throw new NativeRpcError("Owned native socket is closing", "native_process_closing");
    try { this.assertOwned(); }
    catch (error) { this.fail(error); throw error; }
    if (stillPending && !stillPending()) return;
    if (Buffer.byteLength(text) > this.maximum || this.socket.bufferedAmount + Buffer.byteLength(text) > this.maximum * 2) throw new NativeRpcError("Native socket send exceeded its bound", "native_protocol_too_large", true);
    this.socket.send(text);
  }
  close(graceMs = 5000): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.socket.close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([this.ended, new Promise<void>(resolve => { timer = setTimeout(() => { this.socket.terminate(); resolve(); }, graceMs); })]); }
      finally { if (timer) clearTimeout(timer); }
      try {
        await Promise.race([this.received, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new NativeRpcError("Native socket capture did not settle", "native_cleanup_incomplete", true)), 2000); })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.closing;
  }
}
