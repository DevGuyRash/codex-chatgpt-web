import type { CodexParsedRequest } from "../types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Read the canonical native turn metadata carried in Responses client_metadata. */
export function codexNativeTurnMetadata(body: unknown): Record<string, unknown> | undefined {
  const client = record(record(body)?.client_metadata);
  const raw = client?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

/** Native Responses memento compaction emits ordinary assistant text, not an encrypted compaction item. */
export function isLocalMementoCompactionRequest(body: unknown): boolean {
  const metadata = codexNativeTurnMetadata(body);
  const compaction = record(metadata?.compaction);
  return metadata?.request_kind === "compaction"
    && compaction?.implementation === "responses"
    && compaction.strategy === "memento";
}

export function isChatGptCompactionTurn(parsed: Pick<CodexParsedRequest, "_compactionRequest" | "_localMementoCompaction">): boolean {
  return parsed._compactionRequest === true || parsed._localMementoCompaction === true;
}
