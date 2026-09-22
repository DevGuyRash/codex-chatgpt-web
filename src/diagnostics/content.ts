import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { CAPTURE_DOCUMENT_PART_CHARS, MAX_CAPTURE_DOCUMENT_BYTES, ContentCaptureCommandSchema, reportedCaptureDrops, type CaptureCollectionWindow, type ContentCaptureCommand, type DiagnosticWritePhase } from "./contracts";

type ContentCategory = Extract<ContentCaptureCommand, { action: "write" }>["category"];
export interface ContentUpload {
  campaignId: string; traceId: string; category: Exclude<ContentCategory, "screenshot">;
  expectedBytes: number; bytes: number; parts: string[]; expires: number;
}
export function* contentParts(text: string): Generator<string> {
  if (!text.length) { yield ""; return; }
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + CAPTURE_DOCUMENT_PART_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    yield text.slice(start, end); start = end;
  }
}

const credentialKey = /^(?:password|passwd|secret|api[_-]?key|runtime[_-]?key|access[_-]?token|refresh[_-]?token|control[_-]?token|authorization|cookie)$/i;
function quotedEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
  }
  throw new Error("Unterminated credential value");
}
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return quotedEnd(text, start);
  if (text[start] === "{" || text[start] === "[") {
    const stack: string[] = [];
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (character === '"') { index = quotedEnd(text, index) - 1; continue; }
      if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
      else if (character === "}" || character === "]") {
        if (stack.pop() !== character) throw new Error("Invalid credential value");
        if (!stack.length) return index + 1;
      }
      if (stack.length > 64) throw new Error("Credential value exceeds inspection depth");
    }
    throw new Error("Unterminated credential value");
  }
  const primitive = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)/.exec(text.slice(start));
  if (!primitive) throw new Error("Invalid credential value");
  return start + primitive[0].length;
}
function scrubCampaignText(input: string, depth = 0): string {
  if (depth > 64) throw new Error("Campaign content nesting exceeds the inspection bound");
  // Decode only string tokens. Parsing an entire transport would round large JSON numbers before
  // their integrity hash was calculated. Unchanged strings and all other lexemes stay byte exact.
  const strings = /"(?:\\.|[^"\\])*"/g;
  let result = "", cursor = 0, token: RegExpExecArray | null;
  while ((token = strings.exec(input))) {
    let decoded: string;
    try { decoded = JSON.parse(token[0]); } catch { continue; }
    const after = token.index + token[0].length;
    const colon = /^\s*:\s*/.exec(input.slice(after));
    if (colon && credentialKey.test(decoded)) {
      const start = after + colon[0].length, end = valueEnd(input, start);
      result += input.slice(cursor, start) + '"[redacted]"';
      cursor = end; strings.lastIndex = end;
    } else {
      const scrubbed = colon ? decoded : scrubCampaignText(decoded, depth + 1);
      result += input.slice(cursor, token.index) + (scrubbed === decoded ? token[0] : JSON.stringify(scrubbed));
      cursor = after;
    }
  }
  result += input.slice(cursor);
  return result.replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, "[credential]")
    .replace(/\b(?:turn|tunnel)_[A-Za-z0-9_-]{16,}\b/g, "[capability]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/(["'](?:password|passwd|secret|api[_-]?key|runtime[_-]?key|access[_-]?token|refresh[_-]?token|control[_-]?token|authorization|cookie)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, '$1"[redacted]"')
    .replace(/((?:password|passwd|api[_-]?key|runtime[_-]?key|access[_-]?token|control[_-]?token|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    // Quoted transport strings may contain several levels of escaped XML quotes.
    // Their closing escape sequence belongs to the envelope, never to the URL.
    .replace(/https?:\/\/(?:(?!\\+["'])[^\s"'`<>])+/gi, value => { try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "[url]"; } });
}

function collectionCounter(db: Database): number {
  return Number((db.query("SELECT value FROM metadata WHERE key='dropped'").get() as { value: string } | null)?.value ?? 0);
}
function collectionSequence(db: Database): number {
  return Number((db.query("SELECT seq FROM sqlite_sequence WHERE name='events'").get() as { seq: number } | null)?.seq ?? 0);
}
function collectionWindow(db: Database, campaignId: string): CaptureCollectionWindow | null {
  const row = db.query("SELECT start_sequence AS startSequence,start_dropped AS startDropped,end_sequence AS endSequence,end_dropped AS endDropped FROM capture_collection_windows WHERE campaign_id=?").get(campaignId) as Omit<CaptureCollectionWindow, "currentDropped"> | null;
  return row ? { ...row, currentDropped: collectionCounter(db) } : null;
}

/** Only a closed campaign's bound traces entirely inside its ingestion interval can use its loss window. */
export function contentReportScope(db: Database, campaignId: string, traceIds: string[], snapshotSequence: number) {
  const window = collectionWindow(db, campaignId), reportedDrops = reportedCaptureDrops(window);
  if (!window || window.endSequence === null || reportedDrops === null || !traceIds.length) return null;
  const placeholders = traceIds.map(() => "?").join(",");
  const bound = Number((db.query(`SELECT COUNT(*) AS n FROM capture_traces WHERE campaign_id=? AND trace_id IN (${placeholders})`).get(campaignId, ...traceIds) as { n: number }).n);
  if (bound !== new Set(traceIds).size) return null;
  const outside = db.query(`SELECT 1 FROM events WHERE trace_id IN (${placeholders}) AND seq<=? AND (seq<=? OR seq>?) LIMIT 1`).get(...traceIds, snapshotSequence, window.startSequence, window.endSequence);
  if (outside) return null;
  return { campaignId, ...window, reportedDrops };
}

export function contentManifest(db: Database, campaignId: string) {
  const campaign = db.query("SELECT deadline,finished,omitted,max_bytes AS maxBytes FROM capture_campaigns WHERE id=?").get(campaignId) as { deadline: number; finished: number; omitted: number; maxBytes: number } | null;
  if (!campaign) throw new Error("Capture campaign is unavailable");
  const rows = db.query("SELECT id,trace_id AS traceId,category,time,bytes,sha256,document_id AS documentId,document_index AS documentIndex FROM capture_content WHERE campaign_id=? ORDER BY time,id").all(campaignId) as { id: string; traceId: string; category: string; time: number; bytes: number; sha256: string; documentId: string | null; documentIndex: number | null }[];
  const attachments = rows.map(({ documentId, documentIndex, ...row }) => ({ ...row, ...(documentId ? { document: { id: documentId, index: documentIndex! } } : {}) }));
  const documents = db.query("SELECT id,trace_id AS traceId,category,status,input_bytes AS inputBytes,bytes,chunks,sha256 FROM capture_documents WHERE campaign_id=? ORDER BY id").all(campaignId) as { id: string; traceId: string; category: string; status: "receiving" | "stored" | "omitted"; inputBytes: number; bytes: number | null; chunks: number; sha256: string | null }[];
  const traceIds = (db.query("SELECT trace_id AS traceId FROM capture_traces WHERE campaign_id=? ORDER BY trace_id").all(campaignId) as { traceId: string }[]).map(row => row.traceId);
  const collectionFailures = Number((db.query("SELECT COUNT(*) AS n FROM events e JOIN capture_traces t ON t.trace_id=e.trace_id WHERE t.campaign_id=? AND e.name IN ('capture.failed','capture.campaign_failed')").get(campaignId) as { n: number }).n);
  return { campaignId, ...campaign, collectionWindow: collectionWindow(db, campaignId), collectionFailures, traceIds, attachments, documents };
}

function prepareText(text: string): { text: string } | { reason: "authentication-content" | "unsupported-content" } {
  if (/\"(?:cookies|storageState|authorization|access_token|refresh_token)\"\s*:|type=["']password["']/i.test(text)) return { reason: "authentication-content" };
  try { return { text: scrubCampaignText(text) }; } catch { return { reason: "unsupported-content" }; }
}
function capacity(db: Database, campaignId: string, maxBytes: number, bytes: number, count: number, excludingDocument = ""): "attachment-limit" | "storage-budget" | undefined {
  const existing = db.query("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM capture_content WHERE campaign_id=?").get(campaignId) as { count: number; bytes: number };
  if (existing.count + count > 10000) return "attachment-limit";
  const reserved = Number((db.query("SELECT COALESCE(SUM(input_bytes),0) AS n FROM capture_documents WHERE campaign_id=? AND status='receiving' AND id<>?").get(campaignId, excludingDocument) as { n: number }).n);
  const total = Number((db.query("SELECT COALESCE(SUM(bytes),0) AS n FROM capture_content").get() as { n: number }).n);
  const allReserved = Number((db.query("SELECT COALESCE(SUM(input_bytes),0) AS n FROM capture_documents WHERE status='receiving' AND id<>?").get(excludingDocument) as { n: number }).n);
  if (existing.bytes + reserved + bytes > maxBytes || total + allReserved + bytes > 1024 * 1024 * 1024) return "storage-budget";
}
/** Only prepared whole documents or individually inspected writes reach this insertion boundary. */
function insertText(db: Database, campaignId: string, traceId: string, category: ContentCategory, text: string, now: number, document?: { id: string; index: number }) {
  const id = randomUUID(), bytes = Buffer.byteLength(text), sha256 = createHash("sha256").update(text).digest("hex");
  db.query("INSERT INTO capture_content(id,campaign_id,trace_id,category,time,bytes,sha256,text,document_id,document_index) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, campaignId, traceId, category, now, bytes, sha256, text, document?.id ?? null, document?.index ?? null);
  return { status: "stored" as const, id, bytes, sha256 };
}

/** Stored only after explicit scope binding; credentials remain excluded from synthetic content. */
export function captureContent(db: Database, input: ContentCaptureCommand, now: number, uploads: Map<string, ContentUpload>, progress?: (phase: DiagnosticWritePhase) => void): unknown {
  progress?.("validation");
  const command = ContentCaptureCommandSchema.parse(input);
  const applyCommand = () => {
    for (const [id, upload] of uploads) if (upload.expires <= now) {
      uploads.delete(id);
      const changed = db.query("UPDATE capture_documents SET status='omitted' WHERE id=? AND status='receiving'").run(id);
      if (changed.changes) db.query("UPDATE capture_campaigns SET omitted=omitted+1 WHERE id=?").run(upload.campaignId);
    }
    if (command.action === "start") {
      if (command.until <= now || command.until > now + 7 * 86_400_000) throw new Error("Choose a capture horizon within seven days");
      db.query("INSERT INTO capture_campaigns(id,deadline,max_bytes) VALUES(?,?,?)").run(command.campaignId, command.until, command.maxBytes);
      db.query("INSERT INTO capture_collection_windows(campaign_id,start_sequence,start_dropped) VALUES(?,?,?)").run(command.campaignId, collectionSequence(db), collectionCounter(db));
      return { campaignId: command.campaignId, until: command.until, maxBytes: command.maxBytes };
    }
    const campaign = db.query("SELECT deadline,max_bytes,finished,omitted FROM capture_campaigns WHERE id=?").get(command.campaignId) as { deadline: number; max_bytes: number; finished: number; omitted: number } | null;
    if (!campaign) throw new Error("Capture campaign is unavailable");
    if (command.action === "manifest") return contentManifest(db, command.campaignId);
    if (command.action === "finish") {
      db.query("UPDATE capture_collection_windows SET end_sequence=?,end_dropped=? WHERE campaign_id=? AND end_sequence IS NULL").run(collectionSequence(db), collectionCounter(db), command.campaignId);
      db.query("UPDATE capture_campaigns SET finished=1 WHERE id=?").run(command.campaignId);
      for (const [id, upload] of uploads) if (upload.campaignId === command.campaignId) uploads.delete(id);
      return { finished: true };
    }
    if (campaign.finished || campaign.deadline <= now) {
      for (const [id, upload] of uploads) if (upload.campaignId === command.campaignId) uploads.delete(id);
      throw new Error("Capture campaign is not active");
    }
    if (command.action === "bind") {
      if (!db.query("SELECT 1 FROM capture_traces WHERE campaign_id=? AND trace_id=?").get(command.campaignId, command.traceId)
        && Number((db.query("SELECT COUNT(*) AS n FROM capture_traces WHERE campaign_id=?").get(command.campaignId) as { n: number }).n) >= 1000) throw new Error("Finish and rotate this capture campaign before binding another trace");
      db.query("INSERT OR IGNORE INTO capture_traces(campaign_id,trace_id) VALUES(?,?)").run(command.campaignId, command.traceId);
      return { bound: true };
    }
    if (!db.query("SELECT 1 FROM capture_traces WHERE campaign_id=? AND trace_id=?").get(command.campaignId, command.traceId)) throw new Error("Trace is outside this capture scope");
    const omit = (reason: string) => { db.query("UPDATE capture_campaigns SET omitted=omitted+1 WHERE id=?").run(command.campaignId); return { status: "omitted", reason }; };
    if (command.action === "omit") return omit(command.reason);
    if (command.action === "document-start") {
      if (uploads.size >= 8 || [...uploads.values()].reduce((sum, upload) => sum + upload.expectedBytes, command.bytes) > MAX_CAPTURE_DOCUMENT_BYTES) return omit("storage-budget");
      if (Number((db.query("SELECT COUNT(*) AS n FROM capture_documents WHERE campaign_id=?").get(command.campaignId) as { n: number }).n) >= 10000) return omit("attachment-limit");
      const unavailable = capacity(db, command.campaignId, campaign.max_bytes, command.bytes, Math.max(1, Math.ceil(command.bytes / (CAPTURE_DOCUMENT_PART_CHARS - 1))));
      if (unavailable) return omit(unavailable);
      db.query("INSERT INTO capture_documents(id,campaign_id,trace_id,category,status,input_bytes) VALUES(?,?,?,?,'receiving',?)").run(command.documentId, command.campaignId, command.traceId, command.category, command.bytes);
      uploads.set(command.documentId, { campaignId: command.campaignId, traceId: command.traceId, category: command.category, expectedBytes: command.bytes, bytes: 0, parts: [], expires: Math.min(campaign.deadline, now + 60000) });
      return { status: "receiving", documentId: command.documentId, nextIndex: 0 };
    }
    if (command.action === "document-part" || command.action === "document-finish" || command.action === "document-abort") {
      const row = db.query("SELECT status FROM capture_documents WHERE id=? AND campaign_id=? AND trace_id=?").get(command.documentId, command.campaignId, command.traceId) as { status: string } | null;
      if (row?.status !== "receiving") { uploads.delete(command.documentId); throw new Error("Document is not receiving content in this scope"); }
      const abandon = (reason: string) => { uploads.delete(command.documentId); db.query("UPDATE capture_documents SET status='omitted' WHERE id=?").run(command.documentId); return omit(reason); };
      if (command.action === "document-abort") return abandon("capture-failed");
      const upload = uploads.get(command.documentId);
      if (!upload || upload.campaignId !== command.campaignId || upload.traceId !== command.traceId) throw new Error("Document transfer owner is unavailable; partial content cannot be resumed");
      if (command.action === "document-part") {
        if (command.index !== upload.parts.length) throw new Error("Document transport part does not match the next expected index");
        const bytes = Buffer.byteLength(command.text);
        if (upload.bytes + bytes > upload.expectedBytes || upload.parts.length >= 4096) return abandon("too-large");
        upload.parts.push(command.text); upload.bytes += bytes; upload.expires = Math.min(campaign.deadline, now + 60000);
        return { status: "receiving", documentId: command.documentId, nextIndex: upload.parts.length };
      }
      // Raw transport fragments stay only in bounded memory until whole-document privacy inspection.
      uploads.delete(command.documentId);
      if (upload.bytes !== upload.expectedBytes) return abandon("capture-failed");
      const prepared = prepareText(upload.parts.join(""));
      if ("reason" in prepared) return abandon(prepared.reason);
      const bytes = Buffer.byteLength(prepared.text);
      if (bytes > MAX_CAPTURE_DOCUMENT_BYTES) return abandon("too-large");
      const parts = [...contentParts(prepared.text)];
      const unavailable = capacity(db, command.campaignId, campaign.max_bytes, bytes, parts.length, command.documentId);
      if (unavailable) return abandon(unavailable);
      const sha256 = createHash("sha256").update(prepared.text).digest("hex");
      parts.forEach((text, index) => insertText(db, command.campaignId, command.traceId, upload.category, text, now, { id: command.documentId, index }));
      db.query("UPDATE capture_documents SET status='stored',bytes=?,chunks=?,sha256=? WHERE id=?").run(bytes, parts.length, sha256, command.documentId);
      return { status: "stored-document", documentId: command.documentId, bytes, chunks: parts.length, sha256 };
    }
    if (command.category === "screenshot") {
      const png = Buffer.from(command.text, "base64");
      if (png.toString("base64") !== command.text || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return omit("invalid-image");
    }
    const prepared = command.category === "screenshot" ? { text: command.text } : prepareText(command.text);
    if ("reason" in prepared) return omit(prepared.reason);
    const text = prepared.text;
    const bytes = Buffer.byteLength(text);
    if (bytes > 1024 * 1024) return omit("too-large");
    const unavailable = capacity(db, command.campaignId, campaign.max_bytes, bytes, 1);
    if (unavailable) return omit(unavailable);
    return insertText(db, command.campaignId, command.traceId, command.category, text, now);
  };
  progress?.("transaction");
  return db.transaction(() => {
    const result = applyCommand();
    progress?.("commit");
    return result;
  }).immediate();
}

export function contentAttachment(db: Database, campaignId: string, attachment: ReturnType<typeof contentManifest>["attachments"][number], acknowledged: true) {
  if (acknowledged !== true) throw new Error("Content export requires explicit acknowledgement");
  const row = db.query("SELECT id,text,sha256 FROM capture_content WHERE campaign_id=? AND id=?").get(campaignId, attachment.id) as { id: string; text: string; sha256: string } | null;
  if (!row || row.sha256 !== attachment.sha256 || Buffer.byteLength(row.text) !== attachment.bytes || createHash("sha256").update(row.text).digest("hex") !== attachment.sha256) throw new Error("Captured content failed its integrity check or is no longer retained");
  return row;
}

export function* contentAttachments(db: Database, campaignId: string, acknowledged: true) {
  if (acknowledged !== true) throw new Error("Content export requires explicit acknowledgement");
  for (const attachment of contentManifest(db, campaignId).attachments) yield contentAttachment(db, campaignId, attachment, acknowledged);
}
