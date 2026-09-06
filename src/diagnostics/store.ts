import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CaptureCommandSchema, CaptureStateSchema, DEFAULT_RETENTION, QuerySchema, TraceIdSchema, type CaptureWriteResult, type CaptureCommand, type CaptureState, type DiagnosticEvent, type DiagnosticQuery, type DiagnosticStatus, type QueryResult } from "./contracts";
import { safeAttributes, safeLegacyAttributes, safeText, sanitizeEvent } from "./privacy";
import { addEvidenceProjections, SCHEMA_VERSION } from "./schema";

export const STORE_FILENAME = "diagnostics.sqlite";
const PRIVATE_FILENAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.png$/;
type Row = { seq: number; data: string };
type Retention = { days: number; bytes: number; privateMs: number; privateBytes: number };

// This is a read projection of retained evidence, not mutable incident state.
const PROBLEM_CANDIDATE = `(e.kind='problem' OR (e.outcome IN ('failed','interrupted','unknown')
  AND e.id IN (SELECT event_id FROM spans WHERE parent_span_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM events p WHERE p.trace_id=e.trace_id AND p.kind='problem' AND p.seq<=?)))`;
const PROBLEM_SIGNATURE = `json_array(COALESCE(json_extract(e.data,'$.problem.code'),e.outcome),
  COALESCE(json_extract(e.data,'$.problem.stage'),e.name),e.component,e.target,COALESCE(json_extract(e.data,'$.attributes."service.version"'),'unknown'),
  CASE WHEN json_extract(e.data,'$.problem.code')='operation_failed' THEN
    CASE WHEN e.body IN ('Runtime response stream ended unexpectedly','Runtime request returned a failure response','Runtime request failed before completing its response') THEN e.body ELSE COALESCE(e.trace_id,e.id) END
  ELSE '' END)`;
const QUERY_COLUMNS = [["eventId", "id"], ["traceId", "trace_id"], ["taskId", "task_id"], ["target", "target"], ["component", "component"], ["severity", "severity"], ["outcome", "outcome"]] as const;

function fileBytes(path: string): number { try { return statSync(path).size; } catch { return 0; } }
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error("Diagnostics directory must not be a symbolic link");
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

/** SQLite work belongs to a diagnostics worker or an explicitly invoked CLI, never the renderer. */
export class DiagnosticStore {
  readonly directory: string;
  readonly file: string;
  private readonly database: Database | null;
  private readonly readonly: boolean;
  private readonly retention: Retention;
  private readonly now: () => number;
  private readonly notices: string[] = [];
  private writes = 0;

  constructor(directory: string, options: { readonly?: boolean; retention?: Partial<Retention>; now?: () => number } = {}) {
    this.directory = resolve(directory);
    this.file = join(this.directory, STORE_FILENAME);
    this.readonly = options.readonly === true;
    this.retention = { days: DEFAULT_RETENTION.days, bytes: DEFAULT_RETENTION.bytes, privateMs: DEFAULT_RETENTION.privateMs, privateBytes: DEFAULT_RETENTION.privateBytes, ...options.retention };
    this.now = options.now ?? Date.now;
    if (this.readonly && !existsSync(this.file)) { this.database = null; return; }
    if (!this.readonly) privateDirectory(this.directory);
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw new Error("Diagnostics database must not be a symbolic link");
    const database = new Database(this.file, { readonly: this.readonly, create: !this.readonly, strict: true });
    try {
      database.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON");
      const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SCHEMA_VERSION || this.readonly && version !== SCHEMA_VERSION) throw new Error("Diagnostics schema is not supported by this build; use the matching launcher");
      if (!this.readonly) {
        database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=1048576");
        if (process.platform !== "win32") chmodSync(this.file, 0o600);
        if (version === 0) database.transaction(() => {
          if ((database.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 0) return;
          database.exec(`
            CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, time REAL NOT NULL, kind TEXT NOT NULL,
              name TEXT NOT NULL, severity TEXT NOT NULL, component TEXT NOT NULL, target TEXT NOT NULL, trace_id TEXT, span_id TEXT,
              task_id TEXT, outcome TEXT, body TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX events_time ON events(time,seq);
            CREATE INDEX events_trace ON events(trace_id,seq);
            CREATE INDEX events_filters ON events(component,severity,seq);
            CREATE INDEX events_task ON events(task_id,seq);
            CREATE TABLE spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
              terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), PRIMARY KEY(trace_id,span_id));
            CREATE VIRTUAL TABLE event_search USING fts5(name,body,task_id,content='events',content_rowid='seq');
            CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN INSERT INTO event_search(rowid,name,body,task_id) VALUES(new.seq,new.name,new.body,new.task_id); END;
            CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN INSERT INTO event_search(event_search,rowid,name,body,task_id) VALUES('delete',old.seq,old.name,old.body,old.task_id); END;
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE imports (fingerprint TEXT PRIMARY KEY);
            CREATE TABLE attachments (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, filename TEXT NOT NULL UNIQUE, created REAL NOT NULL, expires REAL NOT NULL, bytes INTEGER NOT NULL);
            PRAGMA user_version=1;
          `);
        }).immediate();
        if (version < 2) addEvidenceProjections(database);
      }
      database.query("SELECT count(*) FROM event_search").get();
      this.database = database;
      if (!this.readonly) this.prune();
    } catch (error) { database.close(); throw error; }
  }

  private writable(): Database {
    if (this.readonly || !this.database) throw new Error("Diagnostics store is read-only");
    return this.database;
  }
  private meta(key: string): string | undefined { return (this.database?.query("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | null)?.value; }
  private setMeta(key: string, value: string): void { this.writable().query("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  private evidenceNotices(): string[] {
    const removed = Number(this.meta("retentionRemoved") ?? 0);
    const privateRemoved = Number(this.meta("privateRemoved") ?? 0); const privateMissing = Number(this.meta("privateMissing") ?? 0);
    return [...this.notices, ...(this.meta("legacyNotice") ? [this.meta("legacyNotice")!] : []),
      ...(this.meta("legacyImportPending") === "1" ? ["Legacy import has not finished; historical evidence may be incomplete"] : []),
      ...(removed > 0 ? [`${removed} records removed by retention; older evidence may be unavailable`] : []),
      ...(privateRemoved > 0 ? [`${privateRemoved} private captures expired or were removed by storage limits`] : []),
      ...(privateMissing > 0 ? [`${privateMissing} private captures are missing from storage`] : [])];
  }
  private removeRetained(sql: string, ...values: SQLQueryBindings[]): void {
    const db = this.writable();
    db.transaction(() => {
      db.query(sql).run(...values);
      const count = (db.query("SELECT changes() AS n").get() as { n: number }).n;
      if (count) this.setMeta("retentionRemoved", String(Number(this.meta("retentionRemoved") ?? 0) + count));
    }).immediate();
  }

  append(inputs: unknown[]): number {
    const db = this.writable();
    if (inputs.length > 128) throw new Error("Diagnostics batches are limited to 128 records");
    const events = inputs.map(input => sanitizeEvent(input));
    const insert = db.query("INSERT OR IGNORE INTO events(id,time,kind,name,severity,component,target,trace_id,span_id,task_id,outcome,body,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const span = db.query(`INSERT INTO spans(trace_id,span_id,parent_span_id,event_id,terminal) VALUES(?,?,?,?,?)
      ON CONFLICT(trace_id,span_id) DO UPDATE SET event_id=excluded.event_id,terminal=excluded.terminal WHERE spans.terminal=0`);
    const count = db.transaction(() => {
      let count = 0;
      for (const event of events) {
        insert.run(event.id, event.time, event.kind, event.name, event.severity, event.component, event.target, event.traceId ?? null, event.spanId ?? null,
          event.taskId ?? null, event.span?.outcome ?? null, event.body, JSON.stringify(event));
        // Bun's total change count includes FTS trigger writes; changes() counts the event insert only.
        const inserted = (db.query("SELECT changes() AS n").get() as { n: number }).n;
        count += inserted;
        if (inserted && event.span && event.spanId && event.traceId) span.run(event.traceId, event.spanId, event.parentSpanId ?? null, event.id, event.span.outcome === "running" ? 0 : 1);
      }
      return count;
    })();
    this.writes += count;
    if (this.writes >= 64 || this.bytes() > this.retention.bytes) { this.writes = 0; this.prune(); }
    return count;
  }

  query(input: DiagnosticQuery = {}): QueryResult {
    const query = QuerySchema.parse(input);
    if (query.view === "groups" || query.view === "occurrences") return this.queryGroups(query);
    if (query.follow && !query.ascending) throw new Error("Follow cursors require ascending order");
    const empty: QueryResult = { version: 1, events: [], incomplete: this.meta("legacyImportPending") === "1", notices: this.evidenceNotices() };
    if (!this.database) return { ...empty, notices: ["No diagnostics have been recorded for this target"] };
    if (query.regex) throw new Error("Regex queries require the cancellable diagnostics query worker");
    const where = ["e.time>=?"];
    const values: SQLQueryBindings[] = [Math.max(query.from ?? 0, this.now() - this.retention.days * 86_400_000)];
    const direction = query.ascending ? "ASC" : "DESC";
    let bound = query.snapshotSequence ?? Number((this.database.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get() as { seq: number }).seq);
    let after = 0;
    if (query.cursor) {
      let cursor: { seq: number; bound: number; filter: string };
      try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid diagnostic cursor"); }
      const filter = this.queryFingerprint(query);
      if (!Number.isSafeInteger(cursor.seq) || !Number.isSafeInteger(cursor.bound) || cursor.filter !== filter) throw new Error("Diagnostic cursor does not match this query");
      if (!query.follow) bound = cursor.bound;
      after = cursor.seq;
      where.push(`e.seq${query.ascending ? ">" : "<"}?`); values.push(cursor.seq);
    }
    where.push("e.seq<=?"); values.push(bound);
    for (const [key, column] of QUERY_COLUMNS) {
      if (query[key]) { where.push(`e.${column}=?`); values.push(query[key]); }
    }
    if (query.to !== undefined) { where.push("e.time<=?"); values.push(query.to); }
    if (query.view === "problems") where.push("e.kind='problem'");
    if (query.view === "overview") where.push("(e.kind='problem' OR (e.outcome IN ('failed','interrupted','unknown') AND e.id IN (SELECT event_id FROM spans WHERE parent_span_id IS NULL)))");
    if (query.view === "operations") where.push("s.parent_span_id IS NULL");
    if (query.text?.trim()) {
      where.push("e.seq IN (SELECT rowid FROM event_search WHERE event_search MATCH ?)");
      values.push(query.text.trim().split(/\s+/).map(word => `"${word.replaceAll('"', '""')}"`).join(" AND "));
    }
    const rows = this.database.query(`SELECT e.seq,e.data FROM events e ${query.view === "operations" ? "JOIN spans s ON s.event_id=e.id" : ""}
      WHERE ${where.join(" AND ")} ORDER BY e.seq ${direction} LIMIT ?`).all(...values, query.limit + 1) as Row[];
    const selected = rows.slice(0, query.limit);
    const events = selected.flatMap(row => { try { return [sanitizeEvent(JSON.parse(row.data))]; } catch { empty.incomplete = true; empty.notices.push("A malformed diagnostic record was omitted"); return []; } });
    if (events.some(event => event.attributes["diagnostics.truncated"] === true)) {
      empty.incomplete = true;
      empty.notices.push("Some diagnostic records were truncated to stay within collection limits");
    }
    const starts = events.filter(event => event.span?.outcome === "running").map(event => event.id);
    if (starts.length && this.database.query(`SELECT 1 FROM spans WHERE terminal=0 AND event_id IN (${starts.map(() => "?").join(",")}) LIMIT 1`).get(...starts)) {
      empty.incomplete = true;
      empty.notices.push("Some stages have no terminal record: running is their last observed state, not proof they are still active");
    }
    const last = selected.at(-1);
    const cursorFor = (seq: number) => Buffer.from(JSON.stringify({ seq, bound, filter: this.queryFingerprint(query) })).toString("base64url");
    if (query.follow && after) {
      const oldest = Number((this.database.query("SELECT COALESCE(MIN(seq),0) AS seq FROM events").get() as { seq: number }).seq);
      if (oldest > after + 1) { empty.incomplete = true; empty.notices.push("Retention removed evidence before this follow cursor could read it"); }
    }
    return { ...empty, events, snapshotSequence: bound, ...(query.follow ? { followCursor: cursorFor(last?.seq ?? Math.max(after, bound)) } : {}), ...(rows.length > query.limit && last ? { nextCursor: cursorFor(last.seq) } : {}) };
  }
  private queryGroups(query: ReturnType<typeof QuerySchema.parse>): QueryResult {
    if (query.regex || query.follow) throw new Error("Group queries do not support regex or follow cursors; use raw events");
    const empty: QueryResult = { version: 1, events: [], groups: [], incomplete: this.meta("legacyImportPending") === "1", notices: this.evidenceNotices() };
    if (!this.database) return empty;
    let bound = query.snapshotSequence ?? Number((this.database.query("SELECT COALESCE(MAX(seq),0) AS n FROM events").get() as { n: number }).n);
    let offset = 0;
    const filter = this.queryFingerprint(query);
    if (query.cursor) {
      const cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.bound) || cursor.bound < 0 || cursor.filter !== filter) throw new Error("Group cursor does not match this query");
      offset = cursor.offset; bound = cursor.bound;
    }
    const where = ["e.seq<=?", "e.time>=?", PROBLEM_CANDIDATE];
    const values: SQLQueryBindings[] = [bound, Math.max(query.from ?? 0, this.now() - this.retention.days * 86_400_000), bound];
    for (const [key, column] of QUERY_COLUMNS) if (query[key]) { where.push(`e.${column}=?`); values.push(query[key]); }
    if (query.to !== undefined) { where.push("e.time<=?"); values.push(query.to); }
    if (query.text?.trim()) {
      where.push("e.seq IN (SELECT rowid FROM event_search WHERE event_search MATCH ?)");
      values.push(query.text.trim().split(/\s+/).map(word => `"${word.replaceAll('"', '""')}"`).join(" AND "));
    }
    const selectedGroups = [query.view === "groups" ? "representative=1" : "1=1"];
    if (query.groupKey) { selectedGroups.push("signature=?"); values.push(query.groupKey); }
    const cte = `WITH candidates AS (SELECT e.seq,e.id,e.data,e.time,${PROBLEM_SIGNATURE} AS signature,
      COALESCE(e.trace_id,e.id) AS occurrence FROM events e WHERE ${where.join(" AND ")}),
      ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY occurrence ORDER BY time ASC,seq ASC) AS duplicate FROM candidates),
      occurrences AS (SELECT * FROM ranked WHERE duplicate=1),
      grouped AS (SELECT *,COUNT(*) OVER(PARTITION BY signature) AS count,MIN(time) OVER(PARTITION BY signature) AS first,
        MAX(time) OVER(PARTITION BY signature) AS last,ROW_NUMBER() OVER(PARTITION BY signature ORDER BY time DESC,seq DESC) AS representative FROM occurrences)`;
    const rows = this.database.query(`${cte} SELECT * FROM grouped WHERE ${selectedGroups.join(" AND ")} ORDER BY time DESC,seq DESC LIMIT ? OFFSET ?`)
      .all(...values, query.limit + 1, offset) as Array<{ data: string; signature: string; id: string; count: number; first: number; last: number }>;
    const selected = rows.slice(0, query.limit);
    return { ...empty, snapshotSequence: bound, events: selected.map(row => sanitizeEvent(JSON.parse(row.data))),
      groups: query.view === "groups" ? selected.map(row => ({ key: row.signature, eventId: row.id, occurrences: row.count, firstTime: row.first, lastTime: row.last })) : [],
      ...(rows.length > query.limit ? { nextCursor: Buffer.from(JSON.stringify({ offset: offset + query.limit, bound, filter })).toString("base64url") } : {}) };
  }
  private queryFingerprint(query: ReturnType<typeof QuerySchema.parse>): string {
    const { cursor: _cursor, limit: _limit, ...filter } = query;
    return createHash("sha256").update(JSON.stringify(filter)).digest("hex").slice(0, 24);
  }
  bytes(): number { return [this.file, `${this.file}-wal`, `${this.file}-shm`].reduce((sum, file) => sum + fileBytes(file), 0); }
  private privateBytes(): number {
    try { return readdirSync(join(this.directory, "private")).reduce((sum, file) => sum + fileBytes(join(this.directory, "private", file)), 0); } catch { return 0; }
  }
  captures(): CaptureState {
    let value: CaptureState;
    try { value = CaptureStateSchema.parse(JSON.parse(this.meta("captures") ?? "{}")); } catch { value = CaptureStateSchema.parse({}); }
    return { debugUntil: value.debugUntil > this.now() ? value.debugUntil : 0, privateUntil: value.privateUntil > this.now() ? value.privateUntil : 0, privateScope: value.privateUntil > this.now() ? value.privateScope : "" };
  }
  capture(input: CaptureCommand): CaptureState {
    const command = CaptureCommandSchema.parse(input);
    return this.writable().transaction(() => {
    const value = this.captures();
    if (command.action === "debug-start") value.debugUntil = this.now() + DEFAULT_RETENTION.debugMs;
    if (command.action === "debug-stop") value.debugUntil = 0;
    if (command.action === "private-start") { value.privateUntil = this.now() + DEFAULT_RETENTION.debugMs; value.privateScope = command.scope; }
    if (command.action === "private-stop") { value.privateUntil = 0; value.privateScope = ""; }
    this.setMeta("captures", JSON.stringify(value));
    return value;
    }).immediate();
  }
  claimPrivateCapture(traceId: string): boolean {
    TraceIdSchema.parse(traceId);
    return this.writable().transaction(() => {
      const value = this.captures();
      if (!value.privateUntil) return false;
      if (value.privateScope === "next-browser-turn") { value.privateScope = traceId; this.setMeta("captures", JSON.stringify(value)); }
      return value.privateScope === traceId;
    }).immediate();
  }
  writePrivateCapture(traceId: string, png: Buffer): CaptureWriteResult {
    TraceIdSchema.parse(traceId);
    if (png.byteLength > 1024 * 1024) return { status: "omitted", reason: "too-large" };
    if (png.byteLength < 8 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { status: "omitted", reason: "invalid-image" };
    // Recheck the scope inside the write transaction, so stop/expiry cannot race admission.
    return this.writable().transaction((): CaptureWriteResult => {
      const capture = this.captures();
      if (!capture.privateUntil || capture.privateScope !== traceId) return { status: "omitted", reason: "inactive" };
      if ((this.writable().query("SELECT count(*) AS n FROM attachments").get() as { n: number }).n >= 1024) {
        this.collectionFailure("Private capture file limit reached; clear captures before collecting more");
        return { status: "omitted", reason: "storage-unavailable" };
      }
      const id = randomUUID(); const filename = `${id}.png`;
      const directory = join(this.directory, "private");
      privateDirectory(directory);
      const destination = join(directory, filename);
      try {
        writeFileSync(destination, png, { flag: "wx", mode: 0o600 });
        this.writable().query("INSERT INTO attachments(id,trace_id,filename,created,expires,bytes) VALUES(?,?,?,?,?,?)").run(id, traceId, filename, this.now(), this.now() + this.retention.privateMs, png.byteLength);
      } catch (error) { try { rmSync(destination, { force: true }); } catch { /* Expiry also removes orphan images. */ } throw error; }
      return { status: "stored", id, expires: this.now() + this.retention.privateMs };
    }).immediate();
  }
  dropped(count: number): void { this.setMeta("dropped", String(Number(this.meta("dropped") ?? 0) + count)); }
  collectionFailure(notice: string): void { if (!this.notices.includes(notice) && this.notices.length < 32) this.notices.push(notice); }
  status(): DiagnosticStatus {
    const db = this.database;
    const counts = db?.query("SELECT count(*) AS count,MAX(seq) AS sequence,MIN(time) AS oldest,MAX(time) AS newest,SUM(kind='problem') AS problems FROM events").get() as { count: number; sequence: number | null; oldest: number | null; newest: number | null; problems: number | null } | undefined;
    return { version: 1, available: Boolean(db), schemaVersion: db ? SCHEMA_VERSION : 0, eventCount: counts?.count ?? 0,
      operationCount: db ? Number((db.query("SELECT count(*) AS n FROM spans WHERE parent_span_id IS NULL").get() as { n: number }).n) : 0,
      problemCount: counts?.problems ?? 0, oldestTime: counts?.oldest ?? null, newestTime: counts?.newest ?? null,
      lastSequence: counts?.sequence ?? 0,
      bytes: this.bytes(), privateBytes: this.privateBytes(), dropped: Number(this.meta("dropped") ?? 0), captures: this.captures(), retention: this.retention,
      components: db ? (db.query("SELECT DISTINCT component FROM events ORDER BY component LIMIT 100").all() as { component: string }[]).map(row => row.component) : [],
      targets: db ? (db.query("SELECT DISTINCT target FROM events ORDER BY target LIMIT 100").all() as { target: string }[]).map(row => row.target) : [], notices: this.evidenceNotices(),
    };
  }
  prune(): void {
    const db = this.writable();
    this.removeRetained("DELETE FROM events WHERE time<?", this.now() - this.retention.days * 86_400_000);
    this.prunePrivate();
    // WAL auto-checkpointing already owns routine flushes. An explicit checkpoint
    // on every ingestion batch turns local backfill into repeated disk-sync waits.
    // Reclaim explicitly only when the complete database/WAL budget requires it.
    if (this.bytes() <= this.retention.bytes) return;
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if (this.bytes() <= this.retention.bytes) return;
    for (let attempt = 0; attempt < 16 && this.bytes() > this.retention.bytes; attempt++) {
      this.removeRetained("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq LIMIT 512)");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
    }
    if (this.bytes() > this.retention.bytes && !this.notices.includes("Storage is above its limit; readers or filesystem constraints may be preventing reclamation")) this.notices.push("Storage is above its limit; readers or filesystem constraints may be preventing reclamation");
  }
  private prunePrivate(): void {
    const db = this.writable();
    db.transaction(() => {
    const entries = db.query("SELECT id,filename,expires,bytes FROM attachments ORDER BY created,id").all() as { id: string; filename: string; expires: number; bytes: number }[];
    let bytes = this.privateBytes();
    let removed = 0; let missing = 0;
    for (const entry of entries) {
      if (basename(entry.filename) !== entry.filename) continue;
      const location = join(this.directory, "private", entry.filename);
      if (!existsSync(location)) { db.query("DELETE FROM attachments WHERE id=?").run(entry.id); missing++; }
      else if (entry.expires <= this.now() || bytes > this.retention.privateBytes) {
        const size = fileBytes(location); rmSync(location, { force: true }); bytes -= size;
        db.query("DELETE FROM attachments WHERE id=?").run(entry.id); removed++;
      }
    }
    if (removed) this.setMeta("privateRemoved", String(Number(this.meta("privateRemoved") ?? 0) + removed));
    if (missing) this.setMeta("privateMissing", String(Number(this.meta("privateMissing") ?? 0) + missing));
    // Remove only expired orphan captures from our dedicated directory, never arbitrary paths.
    const known = new Set(entries.map(entry => entry.filename));
    try { for (const file of readdirSync(join(this.directory, "private"))) if (PRIVATE_FILENAME.test(file) && !known.has(file)) {
      const location = join(this.directory, "private", file);
      if (lstatSync(location).isFile() && this.now() - statSync(location).mtimeMs > this.retention.privateMs) rmSync(location);
    } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }).immediate();
  }
  clear(scope: "normal" | "private", confirmed: boolean): DiagnosticStatus {
    if (!confirmed) throw new Error("Clearing diagnostics requires confirmation");
    const db = this.writable();
    if (scope === "normal") { db.exec("DELETE FROM events; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)"); }
    else {
      db.transaction(() => {
      this.setMeta("captures", JSON.stringify({ ...this.captures(), privateUntil: 0, privateScope: "" }));
      const entries = db.query("SELECT filename FROM attachments").all() as { filename: string }[];
      for (const entry of entries) if (basename(entry.filename) === entry.filename) rmSync(join(this.directory, "private", entry.filename), { force: true });
      const directory = join(this.directory, "private");
      if (existsSync(directory)) for (const file of readdirSync(directory)) if (PRIVATE_FILENAME.test(file) && lstatSync(join(directory, file)).isFile()) rmSync(join(directory, file));
      db.exec("DELETE FROM attachments");
      }).immediate();
    }
    return this.status();
  }
  async importLegacy(files: string[], target: string, environment: DiagnosticEvent["environment"], signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    let imported = 0;
    for (const file of files.slice(0, 8)) {
      signal?.throwIfAborted();
      if (!existsSync(file) || !lstatSync(file).isFile() || fileBytes(file) > 8 * 1024 * 1024) continue;
      const text = readFileSync(file, "utf8");
      const fingerprint = createHash("sha256").update(text).digest("hex");
      if (this.database?.query("SELECT fingerprint FROM imports WHERE fingerprint=?").get(fingerprint)) continue;
      this.setMeta("legacyImportPending", "1");
      let batch: DiagnosticEvent[] = [];
      const flush = async () => {
        signal?.throwIfAborted();
        if (batch.length) { imported += this.append(batch); batch = []; }
        // Release the event loop between bounded batches so status, capture controls,
        // current events, and shutdown do not wait behind the entire retained log.
        await new Promise<void>(resolve => setImmediate(resolve));
        signal?.throwIfAborted();
      };
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line && line.length <= 64 * 1024) try {
          const item = JSON.parse(line);
          if (typeof item.at !== "string" || typeof item.event !== "string" || !["debug", "info", "warning", "error"].includes(item.level)) throw new Error("Invalid legacy record");
          const hash = createHash("sha256").update(`${fingerprint}:${index}`).digest("hex");
          const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          batch.push(sanitizeEvent({ version: 1, id, time: Date.parse(item.at), kind: "log", name: safeText(item.event).slice(0, 160), severity: item.level,
            body: "Imported legacy event; original correlation and private output are unavailable", component: "legacy", target, environment,
            attributes: { ...safeLegacyAttributes(item.detail), "diagnostics.legacy": true } }));
        } catch { /* Malformed legacy lines have no authority. */ }
        if ((index + 1) % 128 === 0) await flush();
      }
      await flush();
      this.setMeta("legacyNotice", "Legacy events may be incomplete or uncorrelated");
      this.writable().query("INSERT OR IGNORE INTO imports(fingerprint) VALUES(?)").run(fingerprint);
    }
    if (this.meta("legacyImportPending") === "1") this.setMeta("legacyImportPending", "0");
    return imported;
  }
  close(): void { this.database?.close(); }
}
