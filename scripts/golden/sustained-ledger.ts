import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ProgressSegment } from "./progress";

const require = createRequire(import.meta.url);
const { writePrivateFileAtomic } = require(resolve(import.meta.dir, "../../launcher/electron/atomic-file.cjs")) as {
  writePrivateFileAtomic(path: string, content: string): void;
};

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Thread = z.string().min(1).max(256);
const Segment = z.object({
  startMs: z.number().finite().nonnegative(), endMs: z.number().finite().nonnegative(),
  phase: z.enum(["reasoning", "generation", "tools"]),
  from: z.object({ traceId: z.string().regex(/^[a-f0-9]{32}$/), kind: z.enum(["attachment", "document"]), id: z.string().uuid(), sha256: Digest }).strict(),
  to: z.object({ traceId: z.string().regex(/^[a-f0-9]{32}$/), kind: z.enum(["attachment", "document"]), id: z.string().uuid(), sha256: Digest }).strict(),
}).strict();
const Entry = z.object({ batch: z.number().int().nonnegative(), threadId: Thread, workloadId: Digest, commit: z.string().regex(/^[a-f0-9]{40}$/),
  bundleSha256: Digest, observedMs: z.number().finite().nonnegative(), segments: z.array(Segment).max(100_000),
  previousHash: Digest, hash: Digest }).strict();
const Ledger = z.object({ version: z.literal(2), cellId: Digest, threadId: Thread,
  entries: z.array(Entry).max(10_000),
  pending: z.object({ batch: z.number().int().nonnegative(), reservationId: z.string().uuid(), previousHash: Digest }).strict().optional(),
}).strict();
const LegacyEmptyLedger = z.object({ version: z.literal(1), cellId: Digest, threadId: Thread, entries: z.tuple([]) }).strict();
const GENESIS = "0".repeat(64);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (evidence: ProgressSegment["from"]) => `${evidence.traceId}:${evidence.kind}:${evidence.id}`;

/** Durable credit only for independently accepted batches in one native task. */
export class SustainedProgressLedger {
  private state: z.infer<typeof Ledger>;
  private readonly path: string;

  constructor(path: string, cellId: string, threadId: string) {
    this.path = resolve(path);
    const parent = dirname(this.path), directory = lstatSync(parent);
    if (realpathSync(parent) !== parent || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("Sustained ledger directory is not private and owned");
    if (existsSync(this.path)) {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Sustained ledger file is not private and owned");
    }
    const initial = { version: 2 as const, cellId, threadId, entries: [] };
    const stored: unknown = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : initial;
    const legacy = LegacyEmptyLedger.safeParse(stored);
    if (legacy.success) {
      if (legacy.data.cellId !== cellId || legacy.data.threadId !== threadId) throw new Error("Sustained ledger owner changed");
      this.state = Ledger.parse({ ...legacy.data, version: 2 });
      writePrivateFileAtomic(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    } else {
      if (stored && typeof stored === "object" && "version" in stored && stored.version === 1) throw new Error("Legacy sustained credit or pending work requires manual reconciliation");
      this.state = Ledger.parse(stored);
    }
    if (this.state.cellId !== cellId || this.state.threadId !== threadId) throw new Error("Sustained ledger owner changed");
    this.validate();
  }

  private validate(): void {
    let prior = GENESIS, lastEnd = -Infinity;
    const seen = new Set<string>();
    const workloads = new Set<string>(), commits = new Set<string>(), bundles = new Set<string>();
    for (const [index, entry] of this.state.entries.entries()) {
      if (entry.batch !== index || entry.threadId !== this.state.threadId || entry.previousHash !== prior) throw new Error("Sustained ledger sequence changed");
      const { hash, ...content } = entry;
      if (digest(content) !== hash) throw new Error("Sustained ledger hash changed");
      if (workloads.has(entry.workloadId) || commits.has(entry.commit) || bundles.has(entry.bundleSha256)) throw new Error("Sustained batch reused workload, artifact or evidence identity");
      workloads.add(entry.workloadId);
      commits.add(entry.commit); bundles.add(entry.bundleSha256);
      let measured = 0;
      let previousTo: string | undefined;
      for (const segment of entry.segments) {
        if (segment.startMs < lastEnd || segment.endMs <= segment.startMs || segment.endMs - segment.startMs > 30_000) throw new Error("Sustained progress interval is invalid");
        const from = key(segment.from), to = key(segment.to);
        if (from === to || seen.has(to) || (seen.has(from) && from !== previousTo)) throw new Error("Sustained progress evidence was duplicated");
        seen.add(from); seen.add(to);
        previousTo = to;
        measured += segment.endMs - segment.startMs;
        lastEnd = segment.endMs;
      }
      if (measured <= 0 || measured !== entry.observedMs) throw new Error("Sustained progress credit requires positive observed segments");
      prior = hash;
    }
    if (this.state.pending && (this.state.pending.batch !== this.state.entries.length || this.state.pending.previousHash !== prior)) throw new Error("Sustained pending batch identity changed");
  }

  reserveBatch(): { batch: number; reservationId: string } {
    if (this.state.pending) throw new Error("Sustained batch has an unresolved producer; reconcile its effects before continuing");
    const pending = { batch: this.nextBatch, reservationId: randomUUID(), previousHash: this.state.entries.at(-1)?.hash ?? GENESIS };
    this.state = Ledger.parse({ ...this.state, pending });
    writePrivateFileAtomic(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    return { batch: pending.batch, reservationId: pending.reservationId };
  }

  append(input: { batch: number; reservationId: string; threadId: string; workloadId: string; commit: string; bundleSha256: string; independentlyValid: true;
    progress: { observedMs: number; creditedMs: number; segments: ProgressSegment[] } }): number {
    if (input.independentlyValid !== true || input.progress.observedMs !== input.progress.creditedMs) throw new Error("Sustained batch has no independent credit");
    if (!this.state.pending || this.state.pending.batch !== input.batch || this.state.pending.reservationId !== input.reservationId) throw new Error("Sustained batch is not the exact reserved producer");
    const previousHash = this.state.entries.at(-1)?.hash ?? GENESIS;
    const content = { batch: input.batch, threadId: input.threadId, workloadId: input.workloadId, commit: input.commit,
      bundleSha256: input.bundleSha256, observedMs: input.progress.observedMs,
      segments: input.progress.segments, previousHash };
    const entry = Entry.parse({ ...content, hash: digest(content) });
    const next = Ledger.parse({ ...this.state, entries: [...this.state.entries, entry], pending: undefined });
    const before = this.state;
    this.state = next;
    try {
      this.validate();
      writePrivateFileAtomic(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch (error) { this.state = before; throw error; }
    return this.activeProgressMs;
  }

  get nextBatch(): number { return this.state.entries.length; }
  get pendingBatch(): number | undefined { return this.state.pending?.batch; }
  get threadId(): string { return this.state.threadId; }
  get activeProgressMs(): number { return this.state.entries.reduce((sum, entry) => sum + entry.observedMs, 0); }
  get minimumMet(): boolean { return this.activeProgressMs >= 2 * 60 * 60 * 1000; }
}

export interface ValidatedSustainedBatch {
  threadId: string;
  workloadId: string;
  commit: string;
  bundleSha256: string;
  independentlyValid: true;
  progress: { observedMs: number; creditedMs: number; segments: ProgressSegment[] };
}

/** The next batch is never retried by this owner after an uncertain producer result. */
export async function runSustainedBatchSequence(input: {
  ledger: SustainedProgressLedger;
  signal: AbortSignal;
  maxBatches: number;
  beforeBatch(batch: number, signal: AbortSignal): Promise<void>;
  executeBatch(batch: number, threadId: string, signal: AbortSignal): Promise<ValidatedSustainedBatch>;
  checkpoint(batch: number, activeProgressMs: number): Promise<void>;
}): Promise<{ status: "complete" | "batch-budget"; nextBatch: number; activeProgressMs: number }> {
  if (!Number.isSafeInteger(input.maxBatches) || input.maxBatches < 1 || input.maxBatches > 256) throw new Error("Sustained sequence requires a bounded batch budget");
  let completed = 0;
  while (!input.ledger.minimumMet && completed < input.maxBatches) {
    input.signal.throwIfAborted();
    if (input.ledger.pendingBatch !== undefined) throw new Error("Sustained batch has an unresolved producer; no automatic replay is permitted");
    const batch = input.ledger.nextBatch;
    await input.beforeBatch(batch, input.signal);
    input.signal.throwIfAborted();
    const reservation = input.ledger.reserveBatch();
    const result = await input.executeBatch(batch, input.ledger.threadId, input.signal);
    input.signal.throwIfAborted();
    const activeProgressMs = input.ledger.append({ batch, reservationId: reservation.reservationId, ...result });
    await input.checkpoint(batch, activeProgressMs);
    completed++;
  }
  return { status: input.ledger.minimumMet ? "complete" : "batch-budget",
    nextBatch: input.ledger.nextBatch, activeProgressMs: input.ledger.activeProgressMs };
}
