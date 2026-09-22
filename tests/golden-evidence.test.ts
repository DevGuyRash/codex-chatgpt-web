import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { GoldenEvidence, finishGoldenEvidence } from "../scripts/golden/evidence";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { unzipSync } from "fflate";

test("fresh golden scopes preserve historical losses and reject newly reported losses", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-loss-window-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "golden", target: "fixture", environment: "test" });
  try {
    await client.request({ method: "dropped", count: 3 });
    for (const failed of [false, true, false]) {
      const campaignId = randomUUID(), baseline = (await client.status()).dropped;
      await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
      const evidence = await GoldenEvidence.attach(client, campaignId);
      const operation = diagnostics.begin("fixture.loss-window");
      await evidence.capture(operation.context.traceId, "prompt", "Synthetic independent scope");
      if (failed) {
        await client.request({ method: "dropped", count: 2 });
        await expect(evidence.admission()).rejects.toThrow("collection loss");
      }
      operation.end("succeeded");
      const result = await evidence.finishAndExport(join(root, `${campaignId}.zip`));
      expect(result.incomplete).toBe(failed);
      expect(result.manifest.collectionWindow).toMatchObject({ startDropped: baseline, endDropped: baseline + (failed ? 2 : 0) });
      const report = JSON.parse(new TextDecoder().decode(unzipSync(readFileSync(result.destination))["manifest.json"]));
      expect(report.collectionHealth.dropped).toBe(baseline + (failed ? 2 : 0));
      expect(report.collectionScope.reportedDrops).toBe(failed ? 2 : 0);
    }
    expect((await client.status()).dropped).toBe(5);
  } finally { await diagnostics.close(); await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("golden evidence uses the real worker for complete large capture and an integrity-checked bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const campaignId = randomUUID();
  const diagnostics = new Diagnostics(client, { component: "golden", target: "fixture", environment: "test" });
  const operation = diagnostics.begin("fixture.capture"), traceId = operation.context.traceId;
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
    const evidence = await GoldenEvidence.attach(client, campaignId);
    expect(await evidence.capture(traceId, "prompt", "Synthetic prompt")).toMatchObject({ kind: "attachment", traceId });
    expect(await evidence.capture(traceId, "oracle", "東京🌵".repeat(160000))).toMatchObject({ kind: "document", traceId });
    operation.end("succeeded");
    const result = await evidence.finishAndExport(join(root, "evidence.zip"));
    expect(result.incomplete).toBe(false);
    expect(result.manifest.documents).toHaveLength(1);
    expect(result.bundleSha256).toBe(createHash("sha256").update(readFileSync(result.destination)).digest("hex"));
    await expect(evidence.capture(traceId, "output", "late output")).rejects.toThrow("finished");
    await expect(evidence.admission()).rejects.toThrow("rotate");
  } finally { await diagnostics.close(); await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("rotated scopes include their bound producer traces without inheriting earlier campaign failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-rotation-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "golden", target: "fixture", environment: "test" });
  try {
    for (const failed of [true, false]) {
      const campaignId = randomUUID();
      await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
      const evidence = await GoldenEvidence.attach(client, campaignId);
      const operation = diagnostics.begin(failed ? "earlier.failed" : "current.successful");
      await evidence.capture(operation.context.traceId, "prompt", "Synthetic fixture");
      if (failed) diagnostics.event("capture.failed", "Synthetic earlier collection failure", {}, "warning", operation.context);
      operation.end("succeeded");
      // A separate producer binds through the shared worker, outside the wrapper's local set.
      const producer = diagnostics.begin(failed ? "earlier.child" : "current.child");
      await client.contentCapture({ action: "bind", campaignId, traceId: producer.context.traceId });
      producer.end("succeeded");
      const result = await evidence.finishAndExport(join(root, `${campaignId}.zip`));
      expect(result.incomplete).toBe(failed);
      const events = new TextDecoder().decode(unzipSync(readFileSync(result.destination))["events.jsonl"]);
      expect(events).toContain(failed ? "earlier.child" : "current.child");
      if (!failed) expect(events).not.toContain("earlier.");
    }
  } finally { await diagnostics.close(); await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("omitted required evidence blocks admission but still produces a disclosed failure bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-gap-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const campaignId = randomUUID(), traceId = "b".repeat(32);
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
    const evidence = await GoldenEvidence.attach(client, campaignId);
    await expect(evidence.capture(traceId, "transport", '{"access_token":"synthetic credential"}')).rejects.toThrow("not retained");
    await expect(evidence.admission()).rejects.toThrow("incomplete");
    expect((await evidence.finishAndExport(join(root, "failure.zip"))).incomplete).toBe(true);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a replacement worker exports retained evidence without concealing the lost transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-recovery-"));
  const invocation = { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] };
  const original = new DiagnosticsClient(invocation), campaignId = randomUUID(), traceId = "c".repeat(32);
  let replacement: DiagnosticsClient | undefined;
  try {
    await original.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
    const evidence = await GoldenEvidence.attach(original, campaignId);
    await evidence.capture(traceId, "prompt", "Synthetic interrupted fixture");
    await original.close();
    const diagnostics = await original.status();
    expect(diagnostics.available).toBe(false);
    replacement = new DiagnosticsClient(invocation);
    await expect(GoldenEvidence.recoverFailureExport(replacement, { campaignId, traceId: "d".repeat(32), destination: join(root, "wrong.zip"), diagnostics })).rejects.toThrow("existing campaign trace");
    const result = await finishGoldenEvidence(evidence, original, invocation, traceId, join(root, "failure.zip"));
    expect(result.incomplete).toBe(true);
    expect(result.manifest).toMatchObject({ finished: 1, omitted: 1 });
    expect(result.manifest.attachments.some(item => item.category === "oracle")).toBe(true);
    await expect(GoldenEvidence.attach(replacement, campaignId)).rejects.toThrow("rotate");
    expect((await GoldenEvidence.recoverFailureExport(replacement, { campaignId, traceId, destination: join(root, "reexport.zip"), diagnostics })).incomplete).toBe(true);
  } finally { await original.close(); await replacement?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent production workers retain native-sized content and correlated events without retiring transport", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-evidence-concurrent-"));
  const invocation = { executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] };
  const clients = Array.from({ length: 4 }, () => new DiagnosticsClient(invocation));
  const campaignId = randomUUID();
  const observations: { worker: number; batch: number; sha256: string }[] = [];
  try {
    await clients[0]!.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 2 * 60 * 60 * 1000 });
    const results = await Promise.allSettled(clients.map(async (client, worker) => {
      const diagnostics = new Diagnostics(client, { component: "golden", target: "fixture", environment: "test" });
      const operation = diagnostics.begin("fixture.concurrent-content");
      try {
        const evidence = await GoldenEvidence.attach(client, campaignId);
        for (let batch = 0; batch < 24; batch++) {
          const text = JSON.stringify({ worker, batch, input: Array.from({ length: 128 }, (_, index) => ({ role: "user", text: `${index}: synthetic native request with quoted source \"value\". `.repeat(8) })) });
          const captured = await evidence.capture(operation.context.traceId, "transport", text);
          observations.push({ worker, batch, sha256: captured.sha256 });
          diagnostics.event("fixture.content-retained", "Synthetic content retained", { worker, batch }, "info", operation.context);
        }
        operation.end("succeeded"); await diagnostics.close();
        expect((await client.status()).available).toBe(true);
      } finally { await diagnostics.close(); }
    }));
    expect(results.filter(result => result.status === "rejected")).toEqual([]);
    expect(observations).toHaveLength(96);
    const manifest = await clients[0]!.contentCapture({ action: "manifest", campaignId });
    expect(manifest).toMatchObject({ omitted: 0, collectionFailures: 0 });
    expect("attachments" in manifest && manifest.attachments.length).toBe(96);
  } finally { await Promise.allSettled(clients.map(client => client.close())); rmSync(root, { recursive: true, force: true }); }
}, 30000);
