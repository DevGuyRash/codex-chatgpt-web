import { randomUUID } from "node:crypto";
import { MAX_CAPTURE_DOCUMENT_BYTES, type ContentCaptureCommand } from "./contracts";
import type { DiagnosticsClient } from "./client";
import { contentParts } from "./content";

/** Transfer large documents without enlarging IPC frames or persisting uninspected fragments. */
export async function captureDocument(client: Pick<DiagnosticsClient, "contentCapture">, input: {
  campaignId: string; traceId: string; category: Extract<ContentCaptureCommand, { action: "write" }>["category"]; text: string;
}) {
  const bytes = Buffer.byteLength(input.text);
  if (bytes <= 1024 * 1024) return await client.contentCapture({ action: "write", ...input });
  if (input.category === "screenshot" || bytes > MAX_CAPTURE_DOCUMENT_BYTES) return await client.contentCapture({ action: "omit", campaignId: input.campaignId, traceId: input.traceId, reason: "too-large" });
  const identity = { campaignId: input.campaignId, traceId: input.traceId, documentId: randomUUID() };
  const started = await client.contentCapture({ action: "document-start", ...identity, category: input.category, bytes });
  if ("status" in started && started.status === "omitted") return started;
  try {
    if (!("status" in started) || started.status !== "receiving" || started.documentId !== identity.documentId || started.nextIndex !== 0) throw new Error("Document capture did not acknowledge its new transfer identity");
    let index = 0;
    for (const text of contentParts(input.text)) {
      const result = await client.contentCapture({ action: "document-part", ...identity, index, text });
      if ("status" in result && result.status === "omitted") return result;
      if (!("status" in result) || result.status !== "receiving") throw new Error("Document capture did not acknowledge a transport part");
      if (result.documentId !== identity.documentId || result.nextIndex !== ++index) throw new Error("Document capture acknowledgement does not match its transport position");
    }
    const finished = await client.contentCapture({ action: "document-finish", ...identity });
    if ("status" in finished && (finished.status === "omitted" || finished.status === "stored-document" && finished.documentId === identity.documentId)) return finished;
    throw new Error("Document capture did not acknowledge complete retention");
  } catch (error) {
    try { await client.contentCapture({ action: "document-abort", ...identity }); } catch { /* A lost worker retains its receiving document as incomplete evidence. */ }
    throw error;
  }
}
