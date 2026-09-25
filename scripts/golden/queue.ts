import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { buildGoldenMatrix, matrixSummary, type CapabilitySnapshot, type ExecutionLane, type GoldenCell, type Protocol } from "./catalog";
import { ownedProcessIdentity } from "./workspace";
import { AdmissionHoldSchema, AdmissionObservationSchema, type AdmissionObservation } from "./admission";

const APPLICATION_ID = 0x474f4c44;
const SnapshotSchema = z.object({ inspectedAt: z.string(), source: z.literal("launcher-session-inspection"), capabilities: z.object({ solAvailable: z.boolean(), proAvailable: z.boolean(), experimentalBiggerContext: z.boolean().optional(), browserInteractionMode: z.enum(["automatic", "manual"]).optional(), zeroRiskProEnabled: z.boolean().optional() }).strict(), nativeCodexVersion: z.string().min(1).max(256), nativeCatalogSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const CheckpointSchema = z.object({ threadId: z.string().max(256).optional(), turnId: z.string().max(256).optional(), traceIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(10000).default([]), campaignId: z.string().uuid().optional(), evidenceRoot: z.string().min(1).max(4096).optional(), batch: z.number().int().nonnegative().optional(), activeProgressMs: z.number().nonnegative().optional(), nativePid: z.number().int().positive().optional(), nativeStart: z.string().max(64).optional(), nativeExecutable: z.string().min(1).max(4096).optional() }).strict();
const OutcomeSchema = z.object({
  status: z.enum(["failed", "blocked", "substituted", "passed"]), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096).optional(),
  verification: z.object({ checks: z.array(z.string().max(128)).max(128), observedModel: z.string().max(128), observedEffort: z.string().max(64), activeProgressMs: z.number().nonnegative(), bundleSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type GoldenOutcome = z.input<typeof OutcomeSchema>;
export type GoldenCheckpoint = z.input<typeof CheckpointSchema>;
type ClaimRow = { id: string; token: string; checkpoint: string | null };
const RevisionSchema = z.object({ expectedImplementationSha256: z.string().regex(/^[a-f0-9]{64}$/), implementationSha256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function liveRunner(value: string | undefined): boolean {
  if (!value) return false;
  const owner = z.object({ token: z.string().uuid(), pid: z.number().int().positive(), start: z.string(), executable: z.string() }).strict().parse(JSON.parse(value));
  const actual = ownedProcessIdentity(owner.pid);
  return Boolean(actual && actual.start === owner.start && actual.executable === owner.executable);
}

/** Scheduling state only. Trace, content, failure and export evidence use the production diagnostics system. */
export class GoldenQueue {
  private readonly db: Database;
  private readonly cells: Map<string, GoldenCell>;
  readonly snapshot: CapabilitySnapshot;
  private implementation: string;
  get implementationSha256(): string { return this.implementation; }

  constructor(pathInput: string, initialize?: { snapshot: CapabilitySnapshot; implementationSha256: string }) {
    const path = resolve(pathInput);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error("Campaign queue must be a regular owned file");
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA busy_timeout=5000");
      const id = (this.db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
      if (id !== APPLICATION_ID) {
        const tables = this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get();
        if (id !== 0 || tables || !initialize) throw new Error("Not an initialized golden campaign queue");
        const snapshot = SnapshotSchema.parse(initialize.snapshot);
        if (!/^[a-f0-9]{64}$/.test(initialize.implementationSha256)) throw new Error("A campaign requires an implementation identity");
        const matrix = buildGoldenMatrix(snapshot);
        this.db.transaction(() => {
          this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
            CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE cells(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL,status TEXT NOT NULL,token TEXT,checkpoint TEXT,outcome TEXT,attempt INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
            CREATE TABLE attempts(cell_id TEXT NOT NULL,attempt INTEGER NOT NULL,token TEXT NOT NULL,started INTEGER NOT NULL,finished INTEGER,outcome TEXT,PRIMARY KEY(cell_id,attempt));`);
          this.db.query("INSERT INTO metadata(key,value) VALUES('snapshot',?),('implementation',?)").run(JSON.stringify(snapshot), initialize.implementationSha256);
          const insert = this.db.query("INSERT INTO cells(id,ordinal,status,updated) VALUES(?,?,?,?)");
          matrix.forEach((cell, index) => insert.run(cell.id, index, cell.status, Date.now()));
        }).immediate();
      }
      const schemaVersion = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (![1, 2].includes(schemaVersion)) throw new Error("Unsupported golden queue schema");
      this.snapshot = SnapshotSchema.parse(JSON.parse(this.meta("snapshot")!));
      this.implementation = z.string().regex(/^[a-f0-9]{64}$/).parse(this.meta("implementation"));
      if (initialize && (JSON.stringify(SnapshotSchema.parse(initialize.snapshot)) !== JSON.stringify(this.snapshot) || initialize.implementationSha256 !== this.implementationSha256)) throw new Error("Campaign capability or implementation identity changed; reconcile earlier evidence before continuing");
      if (schemaVersion === 1) this.db.transaction(() => {
        if ((this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version === 2) return;
        if (liveRunner(this.meta("runner"))) throw new Error("Stop the existing scheduler before migrating the golden queue");
        // The only interpolated value is the validated hexadecimal identity; DDL cannot bind a DEFAULT.
        this.db.exec(`ALTER TABLE attempts ADD COLUMN implementation TEXT NOT NULL DEFAULT '${this.implementation}';
          ALTER TABLE attempts ADD COLUMN checkpoint TEXT;
          CREATE TABLE implementation_revisions(id INTEGER PRIMARY KEY,previous TEXT NOT NULL,next TEXT NOT NULL,review TEXT NOT NULL,requeued TEXT NOT NULL,created INTEGER NOT NULL);`);
        this.db.exec("UPDATE attempts SET checkpoint=(SELECT cells.checkpoint FROM cells WHERE cells.id=attempts.cell_id AND cells.attempt=attempts.attempt); PRAGMA user_version=2");
      }).immediate();
      this.cells = new Map(buildGoldenMatrix(this.snapshot).map(cell => [cell.id, cell]));
      const rows = this.db.query("SELECT id FROM cells").all() as { id: string }[];
      if (rows.length !== this.cells.size || rows.some(row => !this.cells.has(row.id))) throw new Error("Campaign coverage differs from its declared full matrix");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      chmodSync(path, 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  private meta(key: string): string | undefined { return (this.db.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value; }
  private assertImplementation(): void { if (this.meta("implementation") !== this.implementation) throw new Error("Campaign implementation changed; reopen and review before admission"); }
  private cell(id: string): GoldenCell { const cell = this.cells.get(id); if (!cell) throw new Error("Unknown golden cell"); return cell; }
  acquireRunner(): string {
    return this.db.transaction(() => {
      this.assertImplementation();
      const value = this.meta("runner");
      if (liveRunner(value)) throw new Error("Another live scheduler owns this golden queue");
      const current = ownedProcessIdentity(process.pid);
      if (!current) throw new Error("Cannot establish scheduler process identity");
      const token = randomUUID();
      this.db.query("INSERT INTO metadata(key,value) VALUES('runner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ token, pid: current.pid, start: current.start, executable: current.executable }));
      return token;
    }).immediate();
  }
  releaseRunner(token: string): void {
    this.db.transaction(() => {
      const value = this.meta("runner");
      if (!value || JSON.parse(value).token !== token) throw new Error("Scheduler ownership changed");
      this.db.query("DELETE FROM metadata WHERE key='runner'").run();
    }).immediate();
  }
  running() {
    return (this.db.query("SELECT id,token,checkpoint FROM cells WHERE status='running' ORDER BY ordinal").all() as ClaimRow[]).map(row => ({ cell: this.cell(row.id), token: row.token, checkpoint: CheckpointSchema.parse(row.checkpoint ? JSON.parse(row.checkpoint) : {}) }));
  }
  nextSchedule(eligible: (cell: GoldenCell) => boolean = () => true): { lane: ExecutionLane; protocol: Protocol } | undefined {
    this.assertImplementation();
    const pending = (this.db.query("SELECT id FROM cells WHERE status='pending' ORDER BY ordinal").all() as { id: string }[]).map(row => this.cell(row.id)).filter(cell => !cell.exclusion && cell.variant.driver !== "assisted" && eligible(cell));
    const next = pending.find(cell => cell.lane === "serial") ?? pending[0];
    return next ? { lane: next.lane, protocol: next.protocol } : undefined;
  }
  claim(input: { lane: ExecutionLane; protocol: Protocol; runnerToken?: string; eligible?: (cell: GoldenCell) => boolean }, now = Date.now()): { cell: GoldenCell; token: string } | null {
    return this.db.transaction(() => {
      this.assertImplementation();
      const runner = this.meta("runner");
      if (runner && JSON.parse(runner).token !== input.runnerToken) throw new Error("Another scheduler owns admission");
      const backoff = this.backoff(); if (backoff && backoff.until > now) return null;
      if (this.admissionHold()) return null;
      const running = this.running();
      if (running.some(row => row.cell.protocol !== input.protocol || row.cell.lane === "serial") || running.length >= (input.lane === "serial" ? 1 : 2)) return null;
      const next = (this.db.query("SELECT id FROM cells WHERE status='pending' ORDER BY ordinal").all() as { id: string }[]).map(row => this.cell(row.id)).find(cell => cell.lane === input.lane && cell.protocol === input.protocol && !cell.exclusion && cell.variant.driver !== "assisted" && (!input.eligible || input.eligible(cell)));
      if (!next) return null;
      const token = randomUUID();
      this.db.query("UPDATE cells SET status='running',token=?,checkpoint=NULL,outcome=NULL,attempt=attempt+1,updated=? WHERE id=? AND status='pending'").run(token, now, next.id);
      this.db.query("INSERT INTO attempts(cell_id,attempt,token,started,implementation) SELECT id,attempt,?,?,? FROM cells WHERE id=?").run(token, now, this.implementation, next.id);
      return { cell: next, token };
    }).immediate();
  }
  checkpoint(id: string, token: string, input: z.input<typeof CheckpointSchema>): void {
    this.db.transaction(() => {
      const row = this.db.query("SELECT checkpoint FROM cells WHERE id=? AND status='running' AND token=?").get(id, token) as { checkpoint: string | null } | null;
      if (!row) throw new Error("Campaign claim is no longer owned by this attempt");
      const previous = CheckpointSchema.parse(row.checkpoint ? JSON.parse(row.checkpoint) : {});
      const checkpoint = CheckpointSchema.parse({ ...previous, ...input, traceIds: [...new Set([...previous.traceIds, ...(input.traceIds ?? [])])] });
      this.db.query("UPDATE cells SET checkpoint=?,updated=? WHERE id=? AND status='running' AND token=?").run(JSON.stringify(checkpoint), Date.now(), id, token);
      this.db.query("UPDATE attempts SET checkpoint=? WHERE cell_id=? AND token=?").run(JSON.stringify(checkpoint), id, token);
    }).immediate();
  }
  settle(id: string, token: string, input: z.input<typeof OutcomeSchema>): void {
    const outcome = OutcomeSchema.parse(input), cell = this.cell(id);
    if (outcome.status === "passed" || outcome.status === "substituted") {
      const proof = outcome.verification;
      const required = ["artifacts", "commit", "settlement", "diagnostics", "no-duplicate-effects", `variant:${cell.variant.id}`];
      if (!outcome.evidence || !proof || required.some(check => !proof.checks.includes(check)) || proof.observedModel !== cell.route.backendModel || proof.observedEffort !== cell.route.adapterEffort || proof.activeProgressMs < (cell.workload === 5 ? 2 * 60 * 60 * 1000 : 0)) throw new Error("Cell lacks its required independent acceptance evidence");
      if (Boolean(cell.variant.controlledFault) !== (outcome.status === "substituted")) throw new Error("Controlled and live boundaries must retain distinct outcomes");
    }
    this.db.transaction(() => {
      const changed = this.db.query("UPDATE cells SET status=?,outcome=?,token=NULL,updated=? WHERE id=? AND status='running' AND token=?").run(outcome.status, JSON.stringify(outcome), Date.now(), id, token);
      if (changed.changes !== 1) throw new Error("Campaign claim is no longer owned by this attempt");
      this.db.query("UPDATE attempts SET finished=?,outcome=? WHERE cell_id=? AND token=?").run(Date.now(), JSON.stringify(outcome), id, token);
    }).immediate();
  }
  deferUntil(until: number, reason: string): void {
    if (!Number.isSafeInteger(until) || until <= Date.now() || !reason || reason.length > 4096) throw new Error("Backoff requires a future observed reset and its reason");
    this.db.transaction(() => {
      if ((this.backoff()?.until ?? 0) > until) return;
      this.db.query("INSERT INTO metadata(key,value) VALUES('backoff',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ until, reason }));
    }).immediate();
  }
  suspendAdmission(input: AdmissionObservation) {
    const observation = AdmissionObservationSchema.parse(input);
    return this.db.transaction(() => {
      const existing = this.admissionHold(); if (existing) return existing;
      const hold = AdmissionHoldSchema.parse({ ...observation, id: randomUUID(), observedAt: Date.now() });
      this.db.query("INSERT INTO metadata(key,value) VALUES('admission_hold',?)").run(JSON.stringify(hold));
      return hold;
    }).immediate();
  }
  resumeAdmission(input: { expectedHoldId: string; reason: string; evidence: string }): void {
    const review = z.object({ expectedHoldId: z.string().uuid(), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096) }).strict().parse(input);
    this.db.transaction(() => {
      const hold = this.admissionHold();
      if (!hold || hold.id !== review.expectedHoldId) throw new Error("Admission hold changed since the resumption review");
      if (this.running().length || liveRunner(this.meta("runner"))) throw new Error("Resolve owned attempts and stop the scheduler before resuming admission");
      this.db.query("INSERT INTO metadata(key,value) VALUES(?,?)").run(`admission_review:${hold.id}`, JSON.stringify({ hold, review }));
      this.db.query("DELETE FROM metadata WHERE key='admission_hold'").run();
    }).immediate();
  }
  /** Reopen an evidence-blocked cell only after reviewing its exact retained outcome. */
  resumeBlockedCell(input: { id: string; expectedAttempt: number; expectedOutcomeSha256: string; reason: string; evidence: string }): void {
    const review = z.object({ id: z.string().regex(/^[a-f\d]{64}$/), expectedAttempt: z.number().int().positive(), expectedOutcomeSha256: z.string().regex(/^[a-f\d]{64}$/), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096) }).strict().parse(input);
    this.db.transaction(() => {
      this.assertImplementation();
      if (this.running().length || liveRunner(this.meta("runner"))) throw new Error("Resolve owned attempts and stop the scheduler before reviewing a blocked cell");
      const row = this.db.query("SELECT status,attempt,outcome FROM cells WHERE id=?").get(review.id) as { status: string; attempt: number; outcome: string | null } | null;
      if (!row || row.status !== "blocked" || row.attempt !== review.expectedAttempt || !row.outcome
        || createHash("sha256").update(row.outcome).digest("hex") !== review.expectedOutcomeSha256) throw new Error("Blocked cell outcome changed since its review");
      this.db.query("INSERT INTO metadata(key,value) VALUES(?,?)").run(`blocked_review:${review.id}:${review.expectedAttempt}`, JSON.stringify(review));
      this.db.query("UPDATE cells SET status='pending',token=NULL,checkpoint=NULL,outcome=NULL,updated=? WHERE id=?").run(Date.now(), review.id);
    }).immediate();
  }
  /** A failed attempt with no native identity can be retried only against its retained review. */
  resumeFailedPreGenerationCell(input: { id: string; expectedAttempt: number; expectedOutcomeSha256: string; expectedCheckpointSha256: string; reason: string; evidence: string }): void {
    const review = z.object({ id: z.string().regex(/^[a-f\d]{64}$/), expectedAttempt: z.number().int().positive(), expectedOutcomeSha256: z.string().regex(/^[a-f\d]{64}$/), expectedCheckpointSha256: z.string().regex(/^[a-f\d]{64}$/), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096) }).strict().parse(input);
    this.db.transaction(() => {
      this.assertImplementation();
      if (this.running().length || liveRunner(this.meta("runner"))) throw new Error("Resolve owned attempts and stop the scheduler before reviewing a failed cell");
      const row = this.db.query("SELECT status,attempt,outcome,checkpoint FROM cells WHERE id=?").get(review.id) as { status: string; attempt: number; outcome: string | null; checkpoint: string | null } | null;
      if (!row || row.status !== "failed" || row.attempt !== review.expectedAttempt || !row.outcome || !row.checkpoint
        || createHash("sha256").update(row.outcome).digest("hex") !== review.expectedOutcomeSha256
        || createHash("sha256").update(row.checkpoint).digest("hex") !== review.expectedCheckpointSha256) throw new Error("Failed cell evidence changed since its review");
      const checkpoint = CheckpointSchema.parse(JSON.parse(row.checkpoint));
      if (checkpoint.threadId || checkpoint.turnId || checkpoint.nativePid || checkpoint.nativeStart || checkpoint.nativeExecutable) throw new Error("A native attempt cannot use pre-generation retry review");
      this.db.query("INSERT INTO metadata(key,value) VALUES(?,?)").run(`pre_generation_review:${review.id}:${review.expectedAttempt}`, JSON.stringify(review));
      this.db.query("UPDATE cells SET status='pending',token=NULL,checkpoint=NULL,outcome=NULL,updated=? WHERE id=?").run(Date.now(), review.id);
    }).immediate();
  }
  private admissionHold() {
    const value = this.meta("admission_hold"); return value ? AdmissionHoldSchema.parse(JSON.parse(value)) : undefined;
  }
  /** Explicit reviewed cutover. Every settled attempted cell needs fresh coverage; prior attempts remain immutable evidence. */
  reconcileImplementation(input: z.input<typeof RevisionSchema>): { requeuedCellIds: string[] } {
    const review = RevisionSchema.parse(input);
    const result = this.db.transaction(() => {
      this.assertImplementation();
      if (review.expectedImplementationSha256 !== this.implementation) throw new Error("Campaign implementation changed since this review");
      if (review.implementationSha256 === this.implementation) throw new Error("Reconciliation requires a changed implementation");
      if (this.running().length) throw new Error("Campaign has unresolved attempts; implementation reconciliation cannot replay them");
      if (liveRunner(this.meta("runner"))) throw new Error("A live scheduler prevents implementation reconciliation");
      // A blocked attempt may retain uncertain external effects or an incomplete export.
      // Changing source cannot authorize replay of that cell; keep its review boundary.
      const rows = this.db.query("SELECT id FROM cells WHERE attempt>0 AND status='passed' ORDER BY ordinal").all() as { id: string }[];
      const requeuedCellIds = rows.map(row => row.id);
      this.db.query("INSERT INTO implementation_revisions(previous,next,review,requeued,created) VALUES(?,?,?,?,?)").run(this.implementation, review.implementationSha256, JSON.stringify(review), JSON.stringify(requeuedCellIds), Date.now());
      this.db.query("UPDATE cells SET status='pending',token=NULL,checkpoint=NULL,outcome=NULL,updated=? WHERE attempt>0 AND status='passed'").run(Date.now());
      this.db.query("UPDATE metadata SET value=? WHERE key='implementation'").run(review.implementationSha256);
      this.db.query("DELETE FROM metadata WHERE key='runner'").run();
      return { requeuedCellIds };
    }).immediate();
    this.implementation = review.implementationSha256;
    return result;
  }
  private backoff(): { until: number; reason: string } | undefined {
    const value = this.meta("backoff"); return value ? z.object({ until: z.number().int(), reason: z.string() }).parse(JSON.parse(value)) : undefined;
  }
  summary() {
    const counts = Object.fromEntries((this.db.query("SELECT status,COUNT(*) AS n FROM cells GROUP BY status").all() as { status: string; n: number }[]).map(row => [row.status, row.n]));
    return { ...matrixSummary([...this.cells.values()]), counts, backoff: this.backoff(), admissionHold: this.admissionHold(), assistedPending: (this.db.query("SELECT id FROM cells WHERE status='pending'").all() as { id: string }[]).filter(row => this.cell(row.id).variant.driver === "assisted").length };
  }
  close(): void { this.db.close(); }
}
