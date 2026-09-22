import { z } from "zod";
import type { ContentCaptureCommand } from "./contracts";
import type { DiagnosticContext } from "./instrumentation";
import { runtimeCaptureClient, runtimeDiagnostics } from "./runtime";
import { captureDocument } from "./document-capture";
import { DiagnosticRequestError } from "./request-error";

type Category = Extract<ContentCaptureCommand, { action: "write" }>["category"];
/** The synthetic runner supplies this scope only to its isolated, owned runtime. */
export function campaignCaptureId(): string | undefined {
  const parsed = z.string().uuid().safeParse(process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID);
  return parsed.success ? parsed.data : undefined;
}

function reportCaptureFailure(error: unknown, context: DiagnosticContext, stage: "capture.content" | "capture.omission", attributes: Record<string, unknown>): void {
  const diagnostics = runtimeDiagnostics();
  const message = stage === "capture.content" ? "Campaign content was not retained" : "Campaign omission could not be persisted";
  const problem = diagnostics?.problem(error, message, { stage }, context);
  // Keep the scope's failure marker even when the content worker has stopped.
  // The ordinary diagnostic sink carries the typed problem independently.
  diagnostics?.event("capture.campaign_failed", message, { ...attributes, ...(problem ? { problemCode: problem.code } : {}) }, "error", context);
}

export async function captureCampaignContent(category: Category, text: string, context: DiagnosticContext | undefined = runtimeDiagnostics()?.context()): Promise<void> {
  const campaignId = campaignCaptureId(), diagnostics = runtimeDiagnostics();
  if (!campaignId || !context) return;
  const client = runtimeCaptureClient();
  if (!client) { reportCaptureFailure(new DiagnosticRequestError("unavailable"), context, "capture.content", { category }); return; }
  try {
    await client.contentCapture({ action: "bind", campaignId, traceId: context.traceId });
    const result = await captureDocument(client, { campaignId, traceId: context.traceId, category, text });
    diagnostics?.event("capture.campaign_result", "Scoped campaign attachment outcome", { category, ...("status" in result ? { result: result.status, ...("id" in result ? { attachmentId: result.id } : "documentId" in result ? { documentId: result.documentId } : "reason" in result ? { reason: result.reason } : {}) } : {}) }, "status" in result && (result.status === "stored" || result.status === "stored-document") ? "info" : "warning", context);
  } catch (error) {
    reportCaptureFailure(error, context, "capture.content", { category });
  }
}

export async function omitCampaignCapture(reason: Extract<ContentCaptureCommand, { action: "omit" }>["reason"], context: DiagnosticContext | undefined = runtimeDiagnostics()?.context()): Promise<void> {
  const campaignId = campaignCaptureId(), client = runtimeCaptureClient();
  if (!campaignId || !context || !client) return;
  try { await client.contentCapture({ action: "bind", campaignId, traceId: context.traceId }); await client.contentCapture({ action: "omit", campaignId, traceId: context.traceId, reason }); }
  catch (error) { reportCaptureFailure(error, context, "capture.omission", { reason }); }
}
