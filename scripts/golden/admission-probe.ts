import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultConfig, providerConfig } from "../../src/config";
import { availableChatGptWebModelRoutes, CHATGPT_WEB_MODEL_ROUTES, CHATGPT_WEB_LUNA_MODEL_ROUTES, type ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { isProGeneration } from "../../src/campaign-policy";
import { LauncherBrowserHelperClient } from "../../src/adapters/chatgpt-web/launcher-helper-client";
import { resolveBrowserConfig } from "../../src/adapters/chatgpt-web/browser-worker";
import type { ChatGptWebCapabilities } from "../../src/adapters/chatgpt-web/model";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { DiagnosticsClient } from "../../src/diagnostics/client";
import { ContentManifestSchema } from "../../src/diagnostics/contracts";
import { closeRuntimeDiagnostics, initializeRuntimeDiagnostics } from "../../src/diagnostics/runtime";
import { DiagnosticError, problemFor } from "../../src/diagnostics/problems";
import { GoldenEvidence, finishGoldenEvidence } from "./evidence";
import { verifyGoldenBrowserHelper } from "./implementation";
import { readGoldenEvents, verifyGoldenModelSelections } from "./observations";
import { GoldenQueue } from "./queue";
import { ownsProcess, restartGoldenLauncher, type GoldenWorkspace } from "./workspace";

/** The real helper must acknowledge cancellation; reaching the callback alone cannot prove settlement. */
export async function probeUnsentSelection(input: {
  client: Pick<LauncherBrowserHelperClient, "run">; route: ChatGptWebModelRoute; capabilities: ChatGptWebCapabilities;
  traceId: string; signal: AbortSignal; onReady(): Promise<void>;
}) {
  if (isProGeneration(input.route) || input.route.interactionMode !== "automatic" || input.capabilities.localToolsEnabled) throw new Error("Selection probes require an automatic non-Pro route without tools");
  input.signal.throwIfAborted();
  const cancelled = new DOMException("Selection probe deliberately withheld Send permission", "AbortError");
  let ready = false, submitted = false, released = false;
  try {
    await input.client.run({ traceId: input.traceId, modelId: input.route.backendModel, reasoning: input.route.adapterEffort, capabilities: input.capabilities,
      abortSignal: input.signal,
      prepare: async () => ({ text: "Synthetic selection-readiness draft. This draft is never submitted.", images: [], release: () => { released = true; } }),
      onSendActivated: async () => { await input.onReady(); ready = true; throw cancelled; },
      onSubmitted: () => { submitted = true; }, onTextDelta: () => { submitted = true; },
    });
    throw new Error("The unsent selection probe unexpectedly completed a browser response");
  } catch (error) {
    if (error !== cancelled || !ready || submitted || !released) throw error;
    input.signal.throwIfAborted();
    return { selectionReady: true as const, sendPermission: "withheld" as const, submitted: false as const };
  }
}

/** Recheck the formerly failing UI boundary without a native task, connector call or ChatGPT submission. */
export async function probeGoldenAdmission(options: { root: string; routeSlug: string; expectedHoldId: string; signal: AbortSignal }) {
  const route = [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LUNA_MODEL_ROUTES].find(route => route.slug === options.routeSlug);
  if (!route || isProGeneration(route) || route.interactionMode !== "automatic") throw new Error("The admission probe requires its explicit permitted route");
  const root = resolve(options.root), queue = new GoldenQueue(join(root, "campaign.sqlite"));
  let runnerToken: string | undefined;
  let client: DiagnosticsClient | undefined;
  try {
    runnerToken = queue.acquireRunner();
    options.signal.throwIfAborted();
    const hold = queue.summary().admissionHold;
    if (!hold || hold.id !== options.expectedHoldId || queue.running().length) throw new Error("The admission probe requires its unchanged hold and reconciled native attempts");
    let workspace = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8")) as GoldenWorkspace;
    if (workspace.root !== root || !workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)) throw new Error("The admission probe requires its owned isolated launcher");
    const helperBuild = verifyGoldenBrowserHelper(resolve(import.meta.dir, "../.."), readLauncherBrowserHostDescriptor(workspace.descriptorPath).helper.script);
    process.env.CODEX_CHATGPT_WEB_HOME = workspace.runtimeHome;
    const invocation = { executable: process.execPath, args: [resolve(import.meta.dir, "../../src/cli.ts"), "--home", workspace.runtimeHome, "diagnostics", "worker"] };
    process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify(invocation);
    client = new DiagnosticsClient(invocation);
    const previous = ContentManifestSchema.parse(await client.contentCapture({ action: "manifest", campaignId: workspace.campaignId }));
    if (!previous.finished) throw new Error("Finish the previous evidence scope before an admission probe");
    const campaignId = randomUUID(), work = join(root, `admission-${campaignId}`);
    mkdirSync(work, { mode: 0o700 });
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 24 * 60 * 60 * 1000, maxBytes: 64 * 1024 * 1024 });
    workspace.campaignId = campaignId;
    writeFileSync(join(root, "workspace.json"), JSON.stringify(workspace, null, 2), { mode: 0o600 });
    process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = campaignId;
    const evidence = await GoldenEvidence.attach(client, campaignId);
    const diagnostics = initializeRuntimeDiagnostics({ component: "golden", sink: client });
    if (!diagnostics) throw new Error("The admission probe has no diagnostic owner");
    const observer = diagnostics.begin("golden.admission_probe", { route: route.slug, holdId: hold.id, browserHelperSha256: helperBuild.sha256 });
    await evidence.bind(observer.context.traceId);
    let failure: unknown, ready = false, stage = "launcher-restart";
    try {
      workspace = await restartGoldenLauncher(root);
      stage = "account-inspection";
      const account = await inspectLauncherBrowserHost(workspace.descriptorPath, { detectCapabilities: true });
      if (typeof account.solAvailable !== "boolean" || typeof account.proAvailable !== "boolean") throw new Error("Account inspection did not return its capabilities");
      const capabilities = { solAvailable: account.solAvailable, proAvailable: account.proAvailable, localToolsEnabled: false };
      if (!availableChatGptWebModelRoutes({ ...capabilities, browserInteractionMode: "automatic" }).some(candidate => candidate.slug === route.slug)) throw new Error("The account does not expose the requested probe route");
      stage = "helper-setup";
      // A standalone launcher deliberately has no saved runtime/tunnel configuration.
      const provider = providerConfig({ ...defaultConfig("browser-only", workspace.runtimeHome), solAvailable: account.solAvailable, proAvailable: account.proAvailable,
        browserHost: "launcher", browserHostDescriptorPath: workspace.descriptorPath, browserInteractionMode: "automatic" });
      const helper = new LauncherBrowserHelperClient({ ...resolveBrowserConfig(provider), turnTimeoutMs: 180_000 });
      const traceId = randomBytes(12).toString("hex"), operation = diagnostics.begin("golden.unsent_selection", { route: route.slug }, null, { id: traceId });
      await evidence.bind(operation.context.traceId);
      try {
        stage = "unsent-selection";
        const result = await operation.run(() => probeUnsentSelection({ client: helper, route, capabilities, traceId, signal: options.signal,
          onReady: async () => { await evidence.capture(operation.context.traceId, "oracle", JSON.stringify({ boundary: "send-ready", sendPermission: "withheld" })); },
        }));
        await evidence.capture(operation.context.traceId, "oracle", JSON.stringify(result));
        operation.end("cancelled");
      } catch (error) { operation.problem(error); operation.end("failed"); throw error; }
      finally { await helper.close(); }
      stage = "selection-evidence";
      const observed = await readGoldenEvents(client, campaignId, { observerTraceId: observer.context.traceId });
      const selections = verifyGoldenModelSelections(observed.events, route, 1);
      if (!selections.passed || observed.events.some(event => event.kind === "problem")) throw new Error("The unsent probe lacks clean observed selection and settlement evidence");
      await evidence.capture(observer.context.traceId, "oracle", JSON.stringify({ selections, scope: "model-control-and-send-readiness", generationAllowance: "unmeasured" }));
      ready = true;
    } catch (error) {
      failure = new DiagnosticError(problemFor(error, `The unsent admission probe failed during ${stage}`, { stage }));
      observer.problem(failure);
    }
    finally { observer.end(ready ? "succeeded" : "failed"); await closeRuntimeDiagnostics(); }
    const pending = { root, work, campaignId, holdId: hold.id, routeSlug: route.slug, ready: false, evidenceExport: "pending", ...(failure ? { problem: problemFor(failure) } : {}) };
    writeFileSync(join(work, "result.json"), JSON.stringify(pending, null, 2), { mode: 0o600 });
    const exported = await finishGoldenEvidence(evidence, client, invocation, observer.context.traceId, join(work, "evidence.zip"));
    const result = { ...pending, ready: ready && !exported.incomplete, evidenceExport: "complete", evidence: exported.destination, bundleSha256: exported.bundleSha256, incomplete: exported.incomplete, generationAllowance: "unmeasured" };
    writeFileSync(join(work, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  } finally {
    try { await client?.close(); }
    finally { try { if (runnerToken) queue.releaseRunner(runnerToken); } finally { queue.close(); } }
  }
}

if (import.meta.main) {
  const controller = new AbortController(), stop = () => controller.abort(new Error("Admission probe observation cancelled"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try { console.log(JSON.stringify(await probeGoldenAdmission({ root: process.argv[2] ?? "context/golden/live", routeSlug: process.argv[3] ?? "", expectedHoldId: process.argv[4] ?? "", signal: controller.signal }))); }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
