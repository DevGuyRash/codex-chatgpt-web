import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { OwnedNativeProcess, NativeRpcError } from "./native-process";
import { OwnedNativeSocket, type OwnedNativeSocketIdentity } from "./native-socket";
export { NativeRpcError } from "./native-process";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
type Frame = { direction: "sent" | "received"; message: ObjectValue };
interface Pending { resolve(value: unknown): void; reject(error: Error): void }
interface Observer extends Pending { method: string; predicate(params: ObjectValue): boolean }

/** One owned process or exact private TUI socket; no shared daemon attachment or automatic replay. */
export class NativeRpc {
  private readonly process?: OwnedNativeProcess;
  private readonly socket?: OwnedNativeSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly observers = new Set<Observer>();
  private nextId = 1;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: {
    onFrame(frame: Frame): void | Promise<void>;
    onStderr?(text: string): void | Promise<void>;
    onServerRequest?(method: string, params: ObjectValue): Promise<unknown>;
    onFailure?(error: Error): void;
    maxFrameBytes?: number;
  } & ({ executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | { socket: OwnedNativeSocketIdentity })) {
    if ("socket" in options) {
      this.socket = new OwnedNativeSocket({ identity: options.socket, maxFrameBytes: options.maxFrameBytes, onMessage: text => this.receive(text), onFailure: error => this.fail(error) });
    } else {
      this.process = new OwnedNativeProcess({ ...options, stdout: stream => this.readStdout(stream), stderr: stream => this.readStderr(stream), onFailure: error => this.fail(error) });
      void this.process.result.then(exit => this.fail(new NativeRpcError("Native process exited before further protocol work could settle", "native_process_exited", this.pending.size > 0, undefined, exit)), error => this.fail(error));
    }
  }

  get pid(): number | undefined { return this.process?.child.pid ?? this.socket?.pid; }
  private fail(error: unknown): void {
    if (this.failure) return;
    this.failure = error instanceof Error ? error : new NativeRpcError("Native protocol failed", "native_protocol_invalid");
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    for (const observer of this.observers) observer.reject(this.failure);
    this.observers.clear();
    this.process?.signal("SIGTERM"); this.socket?.abort();
    this.options.onFailure?.(this.failure);
  }
  private async readStderr(stream: Readable): Promise<void> {
    const decoder = new StringDecoder("utf8");
    for await (const chunk of stream) {
      const text = decoder.write(Buffer.from(chunk));
      if (text) await this.options.onStderr?.(text);
    }
    const final = decoder.end(); if (final) await this.options.onStderr?.(final);
  }
  private async readStdout(stream: Readable): Promise<void> {
    const decoder = new StringDecoder("utf8");
    let text = "", bytes = 0;
    const max = this.options.maxFrameBytes ?? 16 * 1024 * 1024;
    for await (const chunk of stream) {
      bytes += chunk.byteLength; text += decoder.write(Buffer.from(chunk));
      let newline: number;
      while ((newline = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, newline); text = text.slice(newline + 1);
        const size = Buffer.byteLength(line) + 1; bytes -= size;
        if (size > max) throw new NativeRpcError("Native protocol frame exceeded its declared limit", "native_protocol_too_large", true);
        if (line.trim()) await this.receive(line);
      }
      if (bytes > max) throw new NativeRpcError("Native protocol frame exceeded its declared limit", "native_protocol_too_large", true);
    }
    text += decoder.end();
    if (text.trim()) await this.receive(text);
  }
  private async receive(line: string): Promise<void> {
    let message: unknown;
    try { message = JSON.parse(line); } catch { throw new NativeRpcError("Native process emitted malformed JSON", "native_protocol_invalid", true); }
    if (!object(message)) throw new NativeRpcError("Native process emitted a non-object frame", "native_protocol_invalid", true);
    await this.options.onFrame({ direction: "received", message });
    if (typeof message.method === "string") {
      const params = object(message.params) ? message.params : {};
      if (message.id !== undefined) {
        if (typeof message.id !== "number" && typeof message.id !== "string") throw new NativeRpcError("Native request has an invalid identifier", "native_protocol_invalid", true);
        if (!this.options.onServerRequest) throw new NativeRpcError("Native process requested an unconfigured client action", "native_client_action_required", true);
        const result = await this.options.onServerRequest(message.method, params);
        await this.send({ id: message.id, result });
      } else {
        for (const observer of [...this.observers]) if (observer.method === message.method) {
          try { if (observer.predicate(params)) { this.observers.delete(observer); observer.resolve(params); } }
          catch (error) { this.observers.delete(observer); observer.reject(error instanceof Error ? error : new Error("Native event predicate failed")); }
        }
      }
      return;
    }
    if (typeof message.id !== "number") throw new NativeRpcError("Native response has no client request identifier", "native_protocol_invalid", true);
    const pending = this.pending.get(message.id);
    // A timed-out request can still finish; retain its frame as evidence but never resend it.
    if (!pending) return;
    if (object(message.error)) { this.pending.delete(message.id); pending.reject(new NativeRpcError(typeof message.error.message === "string" ? message.error.message : "Native request rejected", "native_rpc_rejected", false, typeof message.error.code === "number" ? message.error.code : undefined)); }
    else if ("result" in message) { this.pending.delete(message.id); pending.resolve(message.result); }
    else throw new NativeRpcError("Native response has neither result nor error", "native_protocol_invalid", true);
  }
  private async send(message: ObjectValue, stillPending?: () => boolean): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closing) throw new NativeRpcError("Native protocol is closing", "native_process_closing");
    const text = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(text) > (this.options.maxFrameBytes ?? 16 * 1024 * 1024)) throw new NativeRpcError("Native request exceeded its declared limit", "native_protocol_too_large");
    await this.options.onFrame({ direction: "sent", message });
    if (this.failure) throw this.failure;
    if (this.closing) throw new NativeRpcError("Native protocol is closing", "native_process_closing");
    if (stillPending && !stillPending()) return;
    if (this.socket) await this.socket.send(text, stillPending);
    else await new Promise<void>((resolve, reject) => this.process!.child.stdin.write(text, error => error ? reject(error) : resolve()));
  }
  async notify(method: string, params: ObjectValue = {}): Promise<void> { await this.send({ method, params }); }
  async request(method: string, params: ObjectValue = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.failure) throw this.failure;
    options.signal?.throwIfAborted();
    if (this.pending.size >= 64) throw new NativeRpcError("Native protocol request limit reached", "native_requests_busy");
    const id = this.nextId++;
    let pending!: Pending;
    const response = new Promise<unknown>((resolve, reject) => { pending = { resolve, reject }; });
    void response.catch(() => {});
    const reject = (error: Error) => { this.pending.delete(id); pending.reject(error); };
    const timer = setTimeout(() => reject(new NativeRpcError(`Native ${method} acknowledgement timed out; submission may have occurred`, "native_acknowledgement_timeout", true)), options.timeoutMs ?? 30_000);
    const aborted = () => reject(new NativeRpcError(`Native ${method} observation was cancelled; submission may have occurred`, "native_observation_cancelled", true));
    options.signal?.addEventListener("abort", aborted, { once: true });
    this.pending.set(id, pending);
    try { return await Promise.race([this.send({ id, method, params }, () => this.pending.has(id)).then(() => response), response]); }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); this.pending.delete(id); }
  }
  waitFor(method: string, predicate: (params: ObjectValue) => boolean, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ObjectValue> {
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.observers.size >= 128) return Promise.reject(new NativeRpcError("Native observation limit reached", "native_observers_busy"));
    return new Promise((resolve, reject) => {
      let observer!: Observer;
      const cleanup = () => { this.observers.delete(observer); clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); };
      const aborted = () => { cleanup(); reject(new NativeRpcError("Native observation was cancelled", "native_observation_cancelled", true)); };
      const timer = setTimeout(() => { cleanup(); reject(new NativeRpcError(`Native ${method} event was not observed`, "native_event_timeout", true)); }, options.timeoutMs ?? 30_000);
      observer = { method, predicate, resolve: value => { cleanup(); resolve(value as ObjectValue); }, reject: error => { cleanup(); reject(error); } };
      this.observers.add(observer); options.signal?.addEventListener("abort", aborted, { once: true });
    });
  }
  close(graceMs = 5000): Promise<void> {
    return this.closing ??= this.socket ? this.socket.close(graceMs).finally(() => this.fail(new NativeRpcError("Owned native socket is closed", "native_socket_closed", true))) : this.process!.close(graceMs);
  }
}
