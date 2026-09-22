import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultConfig } from "../../src/config";
import { CHATGPT_WEB_MODEL_ROUTES } from "../../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../../src/model-catalog";
import { DiagnosticsClient } from "../../src/diagnostics/client";
import { problemFor } from "../../src/diagnostics/problems";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics } from "../../src/diagnostics/runtime";
import { startServer } from "../../src/server";
import { closeChatGptBrowserWorkers } from "../../src/adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers } from "../../src/adapters/chatgpt-web/turn-broker";
import { GoldenAppServer } from "./app-server";
import { GoldenEvidence, finishGoldenEvidence } from "./evidence";
import { goldenNativeConfig, goldenNativeEnvironment } from "./runtime-config";
import { ownsProcess, type GoldenWorkspace } from "./workspace";

/** One live non-Pro Plan boundary, not a full workload cell or tool-acceptance substitute. */
export async function probeLivePlan(rootInput: string, executable: string, prompt = "Create a concise implementation plan for a synthetic order-reconciliation project. Its input rows contain units and integer unitPriceCents. The implementation must reject negative units, calculate exact integer-cent totals, write a JSON report, and verify it against a second dataset. Planning is the entire task in this turn; the input contract above is complete and needs no file or network inspection.") {
  const root = resolve(rootInput), workspace = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8")) as GoldenWorkspace;
  if (workspace.root !== root || !workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)) throw new Error("Live Plan probe requires the owned isolated launcher");
  const inspected = JSON.parse(readFileSync(join(root, "session-inspection.json"), "utf8")) as { inspectedAt: string; solAvailable: boolean; proAvailable: boolean };
  if (Date.now() - Date.parse(inspected.inspectedAt) > 60 * 60 * 1000 || typeof inspected.solAvailable !== "boolean" || typeof inspected.proAvailable !== "boolean") throw new Error("Inspect the signed-in isolated session before the live probe");
  const work = mkdtempSync(join(root, "plan-probe-")), home = join(work, "native-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (spawnSync("git", ["init", "-q", work]).status !== 0) throw new Error("Could not initialize the disposable Plan workspace");
  const nativeEnv = goldenNativeEnvironment(work, home, executable);
  const bundled = spawnSync(executable, ["debug", "models", "--bundled"], { env: nativeEnv, cwd: work, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (bundled.status !== 0) throw new Error("The selected native executable did not expose its bundled catalog");
  const nativeCatalogSha256 = createHash("sha256").update(bundled.stdout).digest("hex");
  writeFileSync(join(work, "native-catalog.json"), bundled.stdout, { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_HOME = workspace.runtimeHome;
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = workspace.campaignId;
  const invocation = { executable: process.execPath, args: [resolve(import.meta.dir, "../../src/cli.ts"), "--home", workspace.runtimeHome, "diagnostics", "worker"] };
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify(invocation);
  const client = new DiagnosticsClient(invocation);
  try {
    let app: GoldenAppServer | undefined, server: ReturnType<typeof startServer> | undefined;
    let failure: unknown;
    let result: { threadId: string; turnId: string; status: string; planItems: number } | undefined;
    const evidence = await GoldenEvidence.attach(client, workspace.campaignId);
    const diagnostics = initializeRuntimeDiagnostics({ component: "golden", sink: client });
    if (!diagnostics) throw new Error("The live probe has no diagnostic owner");
    const operation = diagnostics.begin("golden.live_plan", { boundary: "browser-only-native-plan", nativeCatalogSha256 });
    try {
      await evidence.bind(operation.context.traceId);
      const config = { ...defaultConfig("browser-only", workspace.runtimeHome), port: 0, browserHost: "launcher" as const, browserHostDescriptorPath: workspace.descriptorPath, solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable, autoApproveToolCalls: false };
      const route = CHATGPT_WEB_MODEL_ROUTES.find(route => route.slug === "chatgpt-web/light")!;
      const catalogPath = join(work, "web-models.json");
      writeFileSync(catalogPath, JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)), { mode: 0o600 });
      server = operation.run(() => startServer(config));
      if (!server.port) throw new Error("The live probe did not bind a loopback port");
      writeFileSync(join(home, "config.toml"), goldenNativeConfig({ catalogPath, port: server.port }), { mode: 0o600 });
      const plans = new Set<string>();
      app = new GoldenAppServer({ executable, cwd: work, env: nativeEnv, route, modelProvider: "golden", onFrame: async frame => {
        await evidence.capture(operation.context.traceId, "transport", JSON.stringify(frame));
        const item = frame.message.params && typeof frame.message.params === "object" ? (frame.message.params as { item?: { id?: string; type?: string } }).item : undefined;
        if (frame.direction === "received" && frame.message.method === "item/completed" && item?.type === "plan" && item.id) plans.add(item.id);
      }, onStderr: async text => { await evidence.capture(operation.context.traceId, "transport", text); } });
      await app.initialize();
      const threadId = await app.openThread();
      const turn = await app.startTurn({ mode: "plan", text: prompt });
      writeFileSync(join(work, "checkpoint.json"), JSON.stringify({ threadId, turnId: turn.id, nativePid: app.rpc.pid, scope: "browser-only-native-plan", campaignId: workspace.campaignId }), { mode: 0o600 });
      const terminal = await app.waitForCompletion(turn.id, { timeoutMs: 5 * 60 * 1000 });
      result = { threadId, turnId: turn.id, status: terminal.status, planItems: plans.size };
      await evidence.capture(operation.context.traceId, "oracle", JSON.stringify(result));
      if (terminal.status !== "completed" || plans.size === 0) throw new Error("The live native Plan boundary did not produce a completed native Plan item");
    } catch (error) { failure = error; operation.problem(error); }
    finally {
      const cleanup = await Promise.allSettled([app?.close(), closeChatGptBrowserWorkers(), closeTurnBrokers()]);
      await server?.stop(true);
      const errors = cleanup.flatMap(item => item.status === "rejected" ? [item.reason] : []);
      if (errors.length) failure = new AggregateError([...(failure ? [failure] : []), ...errors], "Live Plan probe cleanup did not settle");
      operation.end(failure ? "failed" : "succeeded");
      await closeRuntimeDiagnostics();
    }
    // Persist the observed outcome before export: a failed evidence transport must not erase
    // submission identity, cleanup findings or the distinction between failed and uncertain work.
    writeFileSync(join(work, "result.json"), JSON.stringify({ boundary: "browser-only-native-plan", work, result, nativeCatalogSha256, passed: false, incomplete: true, evidenceExport: "pending", diagnostics: await client.status(), ...(failure ? { problem: problemFor(failure) } : {}) }, null, 2), { mode: 0o600 });
    const exported = await finishGoldenEvidence(evidence, client, invocation, operation.context.traceId, join(work, "evidence.zip"));
    const summary = { boundary: "browser-only-native-plan", work, result, nativeCatalogSha256, evidence: exported.destination, bundleSha256: exported.bundleSha256, incomplete: exported.incomplete, passed: !failure && !exported.incomplete, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) };
    writeFileSync(join(work, "result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  } finally { await client.close(); }
}

if (import.meta.main) console.log(JSON.stringify(await probeLivePlan(process.argv[2] ?? "context/golden/live", process.argv[3] ?? "/usr/lib/chatgpt/resources/codex", process.argv[4])));
