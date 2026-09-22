import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 6;

/** Events remain authoritative. Projections and their retention are updated in the same transaction. */
export function addEvidenceProjections(database: Database): void {
  database.transaction(() => {
    // Another worker may have upgraded while this connection waited for the write lock.
    const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= 2) return;
    database.exec(`
      CREATE TABLE traces (trace_id TEXT PRIMARY KEY, event_count INTEGER NOT NULL CHECK(event_count >= 0));
      CREATE TABLE problems (event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, code TEXT NOT NULL, recovery TEXT NOT NULL);
      CREATE INDEX problems_code ON problems(code,event_id);
      CREATE TABLE metrics (event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, name TEXT NOT NULL, value REAL NOT NULL CHECK(value >= 0), unit TEXT NOT NULL, PRIMARY KEY(event_id,name));
      INSERT INTO traces SELECT trace_id,count(*) FROM events WHERE trace_id IS NOT NULL GROUP BY trace_id;
      INSERT INTO problems SELECT id,json_extract(data,'$.problem.code'),json_extract(data,'$.problem.recovery') FROM events
        WHERE json_valid(data) AND json_type(data,'$.problem.code')='text' AND json_type(data,'$.problem.recovery')='text';
      INSERT INTO metrics SELECT id,'operation.duration',json_extract(data,'$.span.endTime')-json_extract(data,'$.span.startTime'),'ms' FROM events
        WHERE json_valid(data) AND json_type(data,'$.span.endTime') IN ('integer','real') AND json_type(data,'$.span.startTime') IN ('integer','real')
          AND json_extract(data,'$.span.endTime')>=json_extract(data,'$.span.startTime');
      CREATE TRIGGER evidence_ai AFTER INSERT ON events BEGIN
        INSERT INTO traces(trace_id,event_count) SELECT new.trace_id,1 WHERE new.trace_id IS NOT NULL
          ON CONFLICT(trace_id) DO UPDATE SET event_count=event_count+1;
        INSERT INTO problems SELECT new.id,json_extract(new.data,'$.problem.code'),json_extract(new.data,'$.problem.recovery')
          WHERE json_type(new.data,'$.problem.code')='text' AND json_type(new.data,'$.problem.recovery')='text';
        INSERT INTO metrics SELECT new.id,'operation.duration',json_extract(new.data,'$.span.endTime')-json_extract(new.data,'$.span.startTime'),'ms'
          WHERE json_type(new.data,'$.span.endTime') IN ('integer','real') AND json_type(new.data,'$.span.startTime') IN ('integer','real')
            AND json_extract(new.data,'$.span.endTime')>=json_extract(new.data,'$.span.startTime');
      END;
      CREATE TRIGGER evidence_ad AFTER DELETE ON events WHEN old.trace_id IS NOT NULL BEGIN
        UPDATE traces SET event_count=event_count-1 WHERE trace_id=old.trace_id;
        DELETE FROM traces WHERE trace_id=old.trace_id AND event_count=0;
      END;
      PRAGMA user_version=2;
    `);
  }).immediate();
  database.transaction(() => {
    if ((database.query("PRAGMA user_version").get() as { user_version: number }).user_version >= 3) return;
    database.exec(`
      CREATE TABLE capture_campaigns (id TEXT PRIMARY KEY, deadline REAL NOT NULL, max_bytes INTEGER NOT NULL, finished INTEGER NOT NULL DEFAULT 0, omitted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE capture_traces (campaign_id TEXT NOT NULL REFERENCES capture_campaigns(id) ON DELETE CASCADE, trace_id TEXT NOT NULL, PRIMARY KEY(campaign_id,trace_id));
      CREATE TABLE capture_content (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES capture_campaigns(id) ON DELETE CASCADE, trace_id TEXT NOT NULL, category TEXT NOT NULL, time REAL NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, text TEXT NOT NULL);
      CREATE INDEX capture_content_campaign ON capture_content(campaign_id,time);
      PRAGMA user_version=3;
    `);
  }).immediate();
  database.transaction(() => {
    if ((database.query("PRAGMA user_version").get() as { user_version: number }).user_version >= 4) return;
    database.exec(`
      CREATE TABLE capture_documents (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES capture_campaigns(id) ON DELETE CASCADE, trace_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('receiving','stored','omitted')), input_bytes INTEGER NOT NULL CHECK(input_bytes>=0), bytes INTEGER, chunks INTEGER NOT NULL DEFAULT 0 CHECK(chunks>=0), sha256 TEXT);
      CREATE INDEX capture_documents_campaign ON capture_documents(campaign_id,status);
      ALTER TABLE capture_content ADD COLUMN document_id TEXT REFERENCES capture_documents(id) ON DELETE CASCADE;
      ALTER TABLE capture_content ADD COLUMN document_index INTEGER CHECK(document_index>=0);
      CREATE UNIQUE INDEX capture_content_document_part ON capture_content(document_id,document_index) WHERE document_id IS NOT NULL;
      PRAGMA user_version=4;
    `);
  }).immediate();
  database.transaction(() => {
    if ((database.query("PRAGMA user_version").get() as { user_version: number }).user_version >= 5) return;
    // Admission totals run while holding the capture write transaction. Keep
    // those reads on a compact index rather than pages containing captured text.
    database.exec(`
      CREATE INDEX capture_content_capacity ON capture_content(campaign_id,bytes);
      PRAGMA user_version=5;
    `);
  }).immediate();
  database.transaction(() => {
    if ((database.query("PRAGMA user_version").get() as { user_version: number }).user_version >= 6) return;
    // Legacy campaigns have no observed start boundary. Do not manufacture one
    // from their current counter or infer that their missing records were kept.
    database.exec(`
      CREATE TABLE capture_collection_windows (
        campaign_id TEXT PRIMARY KEY REFERENCES capture_campaigns(id) ON DELETE CASCADE,
        start_sequence INTEGER NOT NULL CHECK(start_sequence>=0),
        start_dropped INTEGER NOT NULL CHECK(start_dropped>=0),
        end_sequence INTEGER CHECK(end_sequence>=start_sequence),
        end_dropped INTEGER CHECK(end_dropped>=start_dropped),
        CHECK((end_sequence IS NULL)=(end_dropped IS NULL))
      );
      PRAGMA user_version=6;
    `);
  }).immediate();
}
