import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NativeRpcError } from "./native-process";
import { ownsProcess, type OwnedProcess } from "./workspace";

export interface OwnedNativeSocketIdentity { path: string; inode: number; owner: OwnedProcess }

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
    const identity = this.options.identity, path = resolve(identity.path);
    const directory = lstatSync(dirname(path)), endpoint = lstatSync(path);
    if (path !== identity.path || realpathSync(path) !== path || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
      || !endpoint.isSocket() || endpoint.ino !== identity.inode || endpoint.uid !== directory.uid || !ownsProcess(identity.owner)) throw new NativeRpcError("Private native socket ownership changed", "native_tui_ownership_missing", true);
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
