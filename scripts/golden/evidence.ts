import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { ContentManifestSchema, reportedCaptureDrops, type ContentCaptureCommand } from "../../src/diagnostics/contracts";
import { DiagnosticsClient, type WorkerInvocation } from "../../src/diagnostics/client";
import { captureDocument } from "../../src/diagnostics/document-capture";
import type { ProgressEvidence } from "./progress";

type EvidenceClient = Pick<DiagnosticsClient, "contentCapture" | "flush" | "status" | "export">;
type Category = Extract<ContentCaptureCommand, { action: "write" }>["category"];

/** For the dedicated synthetic workspace's worker; never attach to production diagnostics. */
export class GoldenEvidence {
  private finished = false;
  private readonly bound = new Set<string>();
  private constructor(private readonly client: EvidenceClient, readonly campaignId: string) {}
  static async attach(client: EvidenceClient, campaignId: string): Promise<GoldenEvidence> {
    const evidence = new GoldenEvidence(client, campaignId);
    await evidence.admission();
    return evidence;
  }
  /** Export retained failure evidence after producers settle; never readmit model work. */
  static async recoverFailureExport(client: EvidenceClient, input: { campaignId: string; traceId: string; destination: string; diagnostics: Awaited<ReturnType<EvidenceClient["status"]>> }) {
    const evidence = new GoldenEvidence(client, input.campaignId);
    const manifest = await evidence.manifest();
    if (!manifest.traceIds.includes(input.traceId)) throw new Error("Failure recovery requires an existing campaign trace");
    if (!manifest.finished) {
      await client.contentCapture({ action: "omit", campaignId: input.campaignId, traceId: input.traceId, reason: "capture-failed" });
      await evidence.capture(input.traceId, "oracle", JSON.stringify({ status: "uncertain", reason: "The original evidence transport failed; retained records cannot establish missing outcomes", diagnostics: input.diagnostics }));
    }
    const exported = await evidence.finishAndExport(input.destination);
    return { ...exported, incomplete: true as const };
  }
  async admission(now = Date.now()): Promise<void> {
    await this.client.flush();
    const status = await this.client.status();
    if (!status.available || status.schemaVersion < 6 || status.notices.length) throw new Error("Golden admission requires available schema-six diagnostics without collection notices");
    const manifest = await this.manifest();
    const used = manifest.attachments.reduce((sum, item) => sum + item.bytes, 0);
    // Reserve headroom between cells. An individual attachment still uses the worker's exact budget.
    if (this.finished || manifest.finished || manifest.deadline - now < 60 * 60 * 1000 || used > manifest.maxBytes * 0.75 || manifest.attachments.length > 7500 || manifest.documents.length > 7500 || manifest.traceIds.length > 750) throw new Error("Finish and rotate this bounded evidence scope before admitting another cell");
    if (reportedCaptureDrops(manifest.collectionWindow) !== 0 || status.dropped !== manifest.collectionWindow?.startDropped) throw new Error("Golden admission requires a recorded capture boundary without collection loss during this scope");
    if (manifest.omitted || manifest.collectionFailures || manifest.documents.some(item => item.status !== "stored")) throw new Error("Golden evidence has incomplete collection requiring reconciliation");
  }
  async bind(traceId: string): Promise<void> {
    if (this.finished) throw new Error("Evidence scope is finished");
    if (this.bound.has(traceId)) return;
    const result = await this.client.contentCapture({ action: "bind", campaignId: this.campaignId, traceId });
    if (!("bound" in result) || !result.bound) throw new Error("Campaign trace binding was not acknowledged");
    this.bound.add(traceId);
  }
  async capture(traceId: string, category: Category, text: string): Promise<ProgressEvidence> {
    await this.bind(traceId);
    const result = await captureDocument(this.client, { campaignId: this.campaignId, traceId, category, text });
    if ("status" in result && result.status === "stored") return { traceId, kind: "attachment", id: result.id, sha256: result.sha256 };
    if ("status" in result && result.status === "stored-document") return { traceId, kind: "document", id: result.documentId, sha256: result.sha256 };
    throw new Error(`Required golden content was not retained: ${"reason" in result ? result.reason : "invalid acknowledgement"}`);
  }
  private async manifest() { return ContentManifestSchema.parse(await this.client.contentCapture({ action: "manifest", campaignId: this.campaignId })); }
  /** Call after every native/runtime producer in this scope has settled, including children and titles. */
  async finishAndExport(destination: string) {
    await this.client.flush();
    const result = await this.client.contentCapture({ action: "finish", campaignId: this.campaignId });
    if (!("finished" in result) || !result.finished) throw new Error("Campaign completion was not acknowledged");
    this.finished = true;
    // Binding belongs to the shared store, so include runtime/child/title traces and their
    // pre-binding events, while preserving earlier failed campaigns in their own bundles.
    const captured = await this.manifest();
    const report = await this.client.export({ format: "bundle", selection: { kind: "selection", traceIds: captured.traceIds }, content: { campaignId: this.campaignId, acknowledged: true } }, destination);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    const manifest = await this.manifest(), status = await this.client.status();
    // Preserve usable failure exports too; callers must not promote an incomplete bundle to a pass.
    return { ...report, incomplete: report.incomplete || !status.available || reportedCaptureDrops(manifest.collectionWindow) !== 0 || status.dropped !== manifest.collectionWindow?.endDropped || status.notices.length > 0, destination, bundleSha256: hash.digest("hex"), manifest };
  }
}

/** The caller must durably record its outcome and settle producers before calling. */
export async function finishGoldenEvidence(evidence: GoldenEvidence, client: DiagnosticsClient, invocation: WorkerInvocation, traceId: string, destination: string) {
  try { return await evidence.finishAndExport(destination); }
  catch (originalError) {
    const diagnostics = await client.status();
    await client.close();
    const replacement = new DiagnosticsClient(invocation);
    try { return await GoldenEvidence.recoverFailureExport(replacement, { campaignId: evidence.campaignId, traceId, destination, diagnostics }); }
    catch (recoveryError) { throw new AggregateError([originalError, recoveryError], "Evidence export failed; the durable probe outcome requires reconciliation"); }
    finally { await replacement.close(); }
  }
}
