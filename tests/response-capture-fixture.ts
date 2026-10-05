import { spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { DiagnosticStore } from "../src/diagnostics/store";
import { ContentCaptureResultSchema, type ContentCaptureCommand, type DiagnosticEvent } from "../src/diagnostics/contracts";
import type { DiagnosticsClient } from "../src/diagnostics/client";
import * as runtime from "../src/diagnostics/runtime";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real store/instrumentation/capture implementation; only its acknowledgement is gated. */
export function responseCaptureFixture(options: { category?: "prompt" | "output"; fail?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "response-producers-"));
  const store = new DiagnosticStore(root), campaignId = randomUUID();
  const priorCampaign = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  const priorDiagnostics = runtime.runtimeDiagnostics();
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = campaignId;
  const events: DiagnosticEvent[] = [], waiting = deferred(), release = deferred(), joining = deferred(), terminal = deferred();
  let acknowledgements = 0, writes = 0;
  const diagnostics = new Diagnostics({ emit(event) {
    events.push(event); store.append([event]);
    if (event.name === "golden.runtime.response_producers_settle" && event.span?.outcome === "running") joining.resolve();
    if (event.name === "adapter.turn" && event.span?.endTime) terminal.resolve();
  } }, { component: "runtime", target: "fixture", environment: "test" });
  runtime.setRuntimeDiagnostics(diagnostics);
  store.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 600_000 });
  const client: Pick<DiagnosticsClient, "contentCapture" | "flush" | "query"> = {
    contentCapture: async (command: ContentCaptureCommand) => {
      if (command.action === "write" && command.category === (options.category ?? "output")) {
        writes++; waiting.resolve(); await release.promise;
        if (options.fail) throw new Error("Synthetic capture acknowledgement failure");
        const result = ContentCaptureResultSchema.parse(store.contentCapture(command));
        acknowledgements++; return result;
      }
      return ContentCaptureResultSchema.parse(store.contentCapture(command));
    },
    flush: async () => {},
    query: async query => store.query(query),
  };
  const capture = spyOn(runtime, "runtimeCaptureClient").mockReturnValue(client as DiagnosticsClient);
  return {
    campaignId, events, store, client, waiting, release, joining, terminal,
    acknowledgements: () => acknowledgements, writes: () => writes,
    async close() {
      release.resolve(); capture.mockRestore(); await diagnostics.close();
      runtime.setRuntimeDiagnostics(priorDiagnostics);
      if (priorCampaign === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
      else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = priorCampaign;
      store.close(); rmSync(root, { recursive: true, force: true });
    },
  };
}
