import { z } from "zod";

const EvidenceSchema = z.object({ traceId: z.string().regex(/^[a-f0-9]{32}$/), kind: z.enum(["attachment", "document"]), id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ProgressEvidence = z.infer<typeof EvidenceSchema>;
export type ProgressPhase = "reasoning" | "generation" | "tools";
export interface ProgressSegment { startMs: number; endMs: number; phase: ProgressPhase; from: ProgressEvidence; to: ProgressEvidence }

/** A conservative observation clock, never a timer-based claim of productive work. */
export class ActiveProgress {
  private lastTime = -Infinity;
  private previous?: { at: number; phase: ProgressPhase; evidence: ProgressEvidence };
  private readonly seen = new Set<string>();
  private segments: ProgressSegment[] = [];
  private acceptedMs = 0;
  constructor(readonly maximumGapMs = 30_000) {
    if (!Number.isSafeInteger(maximumGapMs) || maximumGapMs < 1 || maximumGapMs > 30_000) throw new Error("Progress observations require a gap bound of at most thirty seconds");
  }
  private time(at: number): void {
    if (!Number.isFinite(at) || at < 0 || at < this.lastTime) throw new Error("Progress requires a monotonic observation clock");
    this.lastTime = at;
  }
  /** Call only for new content or tool output whose scoped attachment was acknowledged. */
  observe(at: number, phase: ProgressPhase, input: ProgressEvidence): void {
    this.time(at);
    if (!["reasoning", "generation", "tools"].includes(phase)) throw new Error("Unknown active progress phase");
    const evidence = EvidenceSchema.parse(input), key = `${evidence.traceId}:${evidence.kind}:${evidence.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const previous = this.previous;
    if (previous && previous.phase === phase && at > previous.at && at - previous.at <= this.maximumGapMs) {
      this.segments.push({ startMs: previous.at, endMs: at, phase, from: previous.evidence, to: evidence });
    }
    this.previous = { at, phase, evidence };
  }
  /** Queueing, silence, approval, backoff, a new turn, and observation restart break continuity. */
  pause(at: number): void { this.time(at); this.previous = undefined; }
  /** Persist the returned segments with the independent artifact result before checkpointing the total. */
  finishBatch(at: number, independentlyValid: boolean) {
    this.pause(at);
    const segments = this.segments;
    const observedMs = segments.reduce((total, segment) => total + segment.endMs - segment.startMs, 0);
    if (independentlyValid) this.acceptedMs += observedMs;
    this.segments = [];
    this.seen.clear();
    return { independentlyValid, observedMs, creditedMs: independentlyValid ? observedMs : 0, acceptedMs: this.acceptedMs, maximumGapMs: this.maximumGapMs, segments };
  }
  get activeProgressMs(): number { return this.acceptedMs; }
}
