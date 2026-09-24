import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ActiveProgress, type ProgressEvidence, type ProgressPhase } from "./progress";

const MAX_PENDING_RECORDS = 128;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_UNIQUE_PROGRESS_PAYLOADS = 8192;
const observedNow = () => performance.timeOrigin + performance.now();
const NATIVE_DELTA_METHODS = new Set([
  "item/reasoning/summaryTextDelta", "item/agentMessage/delta",
  "item/plan/delta", "item/commandExecution/outputDelta",
]);
function progressPayload(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const frame = value as Record<string, unknown>;
      const message = frame.message;
      if (frame.direction === "received" && message && typeof message === "object" && !Array.isArray(message)) {
        const native = message as Record<string, unknown>;
        const params = native.params;
        if (NATIVE_DELTA_METHODS.has(String(native.method)) && params && typeof params === "object" && !Array.isArray(params)) {
          const content = params as Record<string, unknown>;
          if (typeof content.threadId === "string" && typeof content.turnId === "string" && typeof content.delta === "string") {
            return JSON.stringify({ method: native.method, threadId: content.threadId, turnId: content.turnId, delta: content.delta });
          }
        }
      }
      if ("receivedAtMs" in frame) {
        const { receivedAtMs: _receipt, ...content } = frame;
        return JSON.stringify(content);
      }
    }
  } catch { /* A native text fragment is still an exact payload identity. */ }
  return text;
}

/** Keep native receipt timing independent of bounded, durable capture latency. */
export class GoldenCaptureLane {
  private tail: Promise<void> = Promise.resolve();
  private pendingRecords = 0;
  private pendingBytes = 0;
  private failure?: Error;
  private readonly progress = new ActiveProgress();
  private readonly seenPayloads = new Set<string>();

  constructor(private readonly capture: (category: "prompt" | "transport", text: string) => Promise<ProgressEvidence>) {}

  record(category: "prompt" | "transport", text: string, phase?: ProgressPhase, receivedAtMs?: number): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (phase && (category !== "transport" || !Number.isFinite(receivedAtMs))) {
      return Promise.reject(new Error("Golden progress needs an observed native transport receipt time"));
    }
    const bytes = Buffer.byteLength(text);
    if (this.pendingRecords >= MAX_PENDING_RECORDS || this.pendingBytes + bytes > MAX_PENDING_BYTES) {
      this.failure = new Error("Golden native capture backlog exceeded its bounded admission; progress is uncertain");
      return Promise.reject(this.failure);
    }
    const promptAtMs = category === "prompt" ? observedNow() : undefined;
    this.pendingRecords += 1;
    this.pendingBytes += bytes;
    const work = this.tail.then(async () => {
      if (this.failure) return;
      const receipt = await this.capture(category, text);
      if (promptAtMs !== undefined) this.progress.pause(promptAtMs);
      if (phase && receivedAtMs !== undefined) {
        const payload = createHash("sha256").update(progressPayload(text)).digest("hex");
        if (!this.seenPayloads.has(payload)) {
          if (this.seenPayloads.size >= MAX_UNIQUE_PROGRESS_PAYLOADS) {
            throw new Error("Golden progress deduplication capacity was reached; rotate the validated batch before crediting more work");
          }
          this.seenPayloads.add(payload);
          this.progress.observe(receivedAtMs, phase, receipt);
        } else {
          // A duplicate is not productive activity and cannot bridge a later gap.
          this.progress.pause(receivedAtMs);
        }
      }
    }).catch(error => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
      this.pendingRecords -= 1;
      this.pendingBytes -= bytes;
    });
    this.tail = work;
    // Input capture is a pre-submission fence. Received frames can continue draining while their
    // bounded capture queue persists them; flush is required before accepting the native result.
    return category === "prompt" ? work.then(() => { if (this.failure) throw this.failure; }) : Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failure) throw this.failure;
  }

  async finishBatch(independentlyValid: boolean) {
    await this.flush();
    return this.progress.finishBatch(observedNow(), independentlyValid);
  }
}
