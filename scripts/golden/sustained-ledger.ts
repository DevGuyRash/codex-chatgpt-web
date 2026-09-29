import { createHash } from "node:crypto";
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
const Entry = z.object({ batch: z.number().int().nonnegative(), threadId: Thread, commit: z.string().regex(/^[a-f0-9]{40}$/),
  bundleSha256: Digest, observedMs: z.number().finite().nonnegative(), segments: z.array(Segment).max(100_000),
  previousHash: Digest, hash: Digest }).strict();
const Ledger = z.object({ version: z.literal(1), cellId: Digest, threadId: Thread,
  entries: z.array(Entry).max(10_000) }).strict();
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
    const initial = { version: 1 as const, cellId, threadId, entries: [] };
    this.state = Ledger.parse(existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : initial);
    if (this.state.cellId !== cellId || this.state.threadId !== threadId) throw new Error("Sustained ledger owner changed");
    this.validate();
  }

  private validate(): void {
    let prior = GENESIS, lastEnd = -Infinity;
    const seen = new Set<string>();
    const commits = new Set<string>(), bundles = new Set<string>();
    for (const [index, entry] of this.state.entries.entries()) {
      if (entry.batch !== index || entry.threadId !== this.state.threadId || entry.previousHash !== prior) throw new Error("Sustained ledger sequence changed");
      const { hash, ...content } = entry;
      if (digest(content) !== hash) throw new Error("Sustained ledger hash changed");
      if (commits.has(entry.commit) || bundles.has(entry.bundleSha256)) throw new Error("Sustained batch reused artifact or evidence identity");
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
      if (measured !== entry.observedMs) throw new Error("Sustained progress credit differs from its observed segments");
      prior = hash;
    }
  }

  append(input: { batch: number; threadId: string; commit: string; bundleSha256: string; independentlyValid: true;
    progress: { observedMs: number; creditedMs: number; segments: ProgressSegment[] } }): number {
    if (input.independentlyValid !== true || input.progress.observedMs !== input.progress.creditedMs) throw new Error("Sustained batch has no independent credit");
    const previousHash = this.state.entries.at(-1)?.hash ?? GENESIS;
    const content = { batch: input.batch, threadId: input.threadId, commit: input.commit,
      bundleSha256: input.bundleSha256, observedMs: input.progress.observedMs,
      segments: input.progress.segments, previousHash };
    const entry = Entry.parse({ ...content, hash: digest(content) });
    const next = Ledger.parse({ ...this.state, entries: [...this.state.entries, entry] });
    const before = this.state;
    this.state = next;
    try {
      this.validate();
      writePrivateFileAtomic(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch (error) { this.state = before; throw error; }
    return this.activeProgressMs;
  }

  get nextBatch(): number { return this.state.entries.length; }
  get activeProgressMs(): number { return this.state.entries.reduce((sum, entry) => sum + entry.observedMs, 0); }
  get minimumMet(): boolean { return this.activeProgressMs >= 2 * 60 * 60 * 1000; }
}
