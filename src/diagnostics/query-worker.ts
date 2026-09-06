import { parentPort, workerData } from "node:worker_threads";
import { DiagnosticStore } from "./store";
import { QuerySchema, type DiagnosticQuery, type QueryResult } from "./contracts";
import { createHash } from "node:crypto";

export function executeQuery(directory: string, input: DiagnosticQuery): QueryResult {
  const query = QuerySchema.parse(input);
  const store = new DiagnosticStore(directory, { readonly: true });
  try {
    if (!query.regex) return store.query(query);
    const regex = new RegExp(query.regex, "iu");
    const fingerprint = createHash("sha256").update(query.regex).digest("hex").slice(0, 24);
    let cursor: string | undefined;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
        if (decoded.regex !== fingerprint || typeof decoded.cursor !== "string") throw new Error();
        cursor = decoded.cursor;
      } catch { throw new Error("Regex cursor does not match this query"); }
    }
    const { regex: _regex, ...base } = query;
    const result: QueryResult = { version: 1, events: [], incomplete: false, notices: [] };
    const deadline = Date.now() + 1000;
    let scanned = 0;
    do {
      const page = store.query({ ...base, cursor, limit: query.limit - result.events.length });
      for (const event of page.events) { scanned++; if (regex.test(`${event.name}\n${event.body}\n${JSON.stringify(event.attributes)}`)) result.events.push(event); }
      cursor = page.nextCursor;
      result.incomplete ||= page.incomplete;
      result.notices.push(...page.notices);
      if (page.followCursor) result.followCursor = Buffer.from(JSON.stringify({ cursor: page.followCursor, regex: fingerprint })).toString("base64url");
      if (result.events.length === query.limit || !cursor) break;
    } while (scanned < 20_000 && Date.now() < deadline);
    if (cursor) result.nextCursor = Buffer.from(JSON.stringify({ cursor, regex: fingerprint })).toString("base64url");
    if (cursor && result.events.length < query.limit) { result.incomplete = true; result.notices.push("Search reached its work budget; narrow filters or load the next page"); }
    return result;
  } finally { store.close(); }
}

if (parentPort) {
  try { parentPort.postMessage({ ok: true, result: executeQuery(workerData.directory, workerData.query) }); }
  catch { parentPort.postMessage({ ok: false, error: "Diagnostic search failed; check the query syntax or store compatibility" }); }
}
