import type { Database } from "bun:sqlite";

export const SCHEMA_VERSION = 2;

/** Events remain authoritative. Projections and their retention are updated in the same transaction. */
export function addEvidenceProjections(database: Database): void {
  database.transaction(() => {
    // Another worker may have upgraded while this connection waited for the write lock.
    const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= SCHEMA_VERSION) return;
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
}
