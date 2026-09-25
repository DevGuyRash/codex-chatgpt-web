import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";
import { loadConfig } from "../../src/config";
import { availableChatGptWebModelRoutes, CHATGPT_WEB_MODEL_ROUTES, CHATGPT_WEB_LUNA_MODEL_ROUTES } from "../../src/chatgpt-web-models";
import { isProGeneration } from "../../src/campaign-policy";
import { augmentNativeModelCatalog } from "../../src/model-catalog";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { DiagnosticsClient } from "../../src/diagnostics/client";
import { ContentManifestSchema } from "../../src/diagnostics/contracts";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics } from "../../src/diagnostics/runtime";
import { DiagnosticError, problemFor } from "../../src/diagnostics/problems";
import { GoldenEvidence, finishGoldenEvidence } from "./evidence";
import { GoldenCaptureLane } from "./capture-lane";
import { runNativeScenario, finiteNativeScenarios, type FiniteNativeScenario, type NativeScenarioCheckpoint } from "./native-scenarios";
import { findNativeScenarioFailure, type NativeScenarioFailure } from "./structured-scenarios";
import { findNativeTuiTitleFailure } from "./tui-scenarios";
import { findNativeExecFailure, type NativeExecFailure } from "./exec";
import { initializeGoldenNativeHome } from "./app-server";
import { goldenScenarioTerminations, readGoldenEvents, readGoldenAdmissionEvents, selectGoldenNativeThreadEvents, verifyGoldenModelSelections, verifyGoldenModelSequence, verifyGoldenToolReceipts, verifyGoldenTuiTitles } from "./observations";
import { goldenNativeConfig, goldenNativeEnvironment } from "./runtime-config";
import { withGoldenRuntime } from "./runtime";
import { assertBorrowedTunnelInactive } from "./borrowed-tunnel";
import { createWorkload, evaluateWorkload, materializeWorkload } from "./workloads";
import { runProjectOracle, verifyArtifactCommit } from "./oracle";
import { ownedProcessIdentity, ownsProcess, restartGoldenLauncher, type GoldenWorkspace } from "./workspace";
import type { Protocol, WorkloadLevel } from "./catalog";
import { verifyGoldenBrowserHelper } from "./implementation";
import { GoldenQueue } from "./queue";
import { paceGoldenGeneration } from "./pacing";
import { GoldenAdmissionSuspended, nativeAdmissionObservation, diagnosticAdmissionObservation, type AdmissionObservation } from "./admission";

/** Checkpoint admission before optional capture/export can fail; this does not settle the producer. */
export function retainLiveAdmissionFailure(root: string, evidencePath: string, failure: NativeScenarioFailure["nativeFailure"]) {
  const observation = nativeAdmissionObservation(failure, evidencePath);
  if (!observation) return;
  return retainLiveAdmissionObservation(root, evidencePath, observation);
}

export function retainLiveAdmissionObservation(root: string, evidencePath: string, observation: AdmissionObservation) {
  const queue = new GoldenQueue(join(root, "campaign.sqlite"));
  try {
    let hold;
    try { writeFileSync(evidencePath, JSON.stringify(observation, null, 2), { mode: 0o600 }); }
    finally { hold = queue.suspendAdmission(observation); }
    return hold;
  }
  finally { queue.close(); }
}

/** Provider evidence can constrain admission even when native exec lacks a typed provider code. */
export async function retainLiveProviderAdmission(client: Pick<DiagnosticsClient, "flush" | "contentCapture" | "query">, input: {
  root: string; campaignId: string; observerTraceId: string; ownedThreadIds: readonly string[]; evidencePath: string;
}): Promise<AdmissionObservation | undefined> {
  if (!input.ownedThreadIds.length) return undefined;
  const structural = await readGoldenAdmissionEvents(client, input.campaignId, input.observerTraceId);
  const observation = diagnosticAdmissionObservation(structural.events, input.ownedThreadIds, input.evidencePath);
  if (observation) retainLiveAdmissionObservation(input.root, input.evidencePath, observation);
  return observation;
}

export interface LiveBatchCell {
  id: string; routeSlug: string; workload: WorkloadLevel; variant: FiniteNativeScenario;
  checkpoint?(input: NativeScenarioCheckpoint & { traceId: string; campaignId: string; work: string }): void | Promise<void>;
}

/** One owned runtime and native home for a serial cell or a concurrent pair. No queue status is inferred here. */
export async function runLiveBatch(options: {
  root: string; sourceHome: string; executable: string; cells: readonly LiveBatchCell[]; signal: AbortSignal;
  protocol?: Protocol; turnTimeoutMs: number; boundary?: "ordinary-native-tools" | "campaign-batch";
  onPrepared?(identity: { work: string; campaignId: string; traceId: string }): void | Promise<void>;
}) {
  options.signal.throwIfAborted();
  if (!options.cells.length || options.cells.length > 2 || new Set(options.cells.map(cell => cell.id)).size !== options.cells.length) throw new Error("A live batch requires one or two distinct owned cells");
  if (!Number.isSafeInteger(options.turnTimeoutMs) || options.turnTimeoutMs < 1) throw new Error("A live batch requires a finite turn observation deadline");
  const requests = options.cells.map(cell => {
    const route = [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LUNA_MODEL_ROUTES].find(route => route.slug === cell.routeSlug);
    if (!/^[a-f\d]{64}$/.test(cell.id) || ![1, 2, 3, 4].includes(cell.workload) || !Object.hasOwn(finiteNativeScenarios, cell.variant)) throw new Error("The live batch requires implemented finite workload cells; sustained and other scenario coordinators remain separate");
    if (!route || isProGeneration(route) || route.interactionMode !== "automatic") throw new Error("The live batch requires permitted automatic non-Pro routes");
    return { ...cell, route };
  });
  const root = resolve(options.root), sourceHome = resolve(options.sourceHome), boundary = options.boundary ?? "campaign-batch";
  {
    const queue = new GoldenQueue(join(root, "campaign.sqlite"));
    try {
      const hold = queue.summary().admissionHold;
      if (hold) {
        const { id: _id, observedAt: _observedAt, ...observation } = hold;
        throw new GoldenAdmissionSuspended(observation);
      }
    } finally { queue.close(); }
  }
  let workspace = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8")) as GoldenWorkspace;
  if (workspace.root !== root || !workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)) throw new Error("A live batch requires the owned isolated launcher");
  const helperBuild = verifyGoldenBrowserHelper(resolve(import.meta.dir, "../.."), readLauncherBrowserHostDescriptor(workspace.descriptorPath).helper.script);
  const source = loadConfig(sourceHome), protocol = options.protocol ?? source.subagentProtocol;
  if (source.mode !== "full" || !source.tunnel) throw new Error("The selected existing runtime has no full-mode tunnel configuration");
  await assertBorrowedTunnelInactive(sourceHome, root, source);
  const work = mkdtempSync(join(root, "batch-")), home = join(work, "native-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const nativeEnv = goldenNativeEnvironment(work, home, options.executable);
  const cells = requests.map(request => {
    const task = join(work, "cells", request.id), workload = createWorkload({ level: request.workload, seed: `${request.id}:${randomUUID()}`, batch: 0, ...(["formats", "tool-image"].includes(request.variant) ? { formatCoverage: "all" as const } : {}) });
    materializeWorkload(task, workload);
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", task, ...args], { env: nativeEnv, encoding: "utf8", timeout: 15000 });
      if (result.status !== 0) throw new Error("Disposable repository initialization failed");
      return result.stdout.trim();
    };
    git("init", "-q"); git("config", "user.name", "Golden Test"); git("config", "user.email", "golden@example.invalid");
    git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", "/dev/null"); git("add", "."); git("commit", "-qm", "Synthetic workload inputs");
    return { request, task, workload, baseline: git("rev-parse", "HEAD") };
  });
  const bundled = spawnSync(options.executable, ["debug", "models", "--bundled"], { env: nativeEnv, cwd: work, encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (bundled.status !== 0) throw new Error("The selected native executable did not expose its bundled catalog");
  const nativeCatalogSha256 = createHash("sha256").update(bundled.stdout).digest("hex");
  writeFileSync(join(work, "native-catalog.json"), bundled.stdout, { mode: 0o600 });
  process.env.CODEX_CHATGPT_WEB_HOME = workspace.runtimeHome;
  const invocation = { executable: process.execPath, args: [resolve(import.meta.dir, "../../src/cli.ts"), "--home", workspace.runtimeHome, "diagnostics", "worker"] };
  process.env.CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER = JSON.stringify(invocation);
  const client = new DiagnosticsClient(invocation);
  try {
    const prior = ContentManifestSchema.parse(await client.contentCapture({ action: "manifest", campaignId: workspace.campaignId }));
    if (!prior.finished) throw new Error("The previous campaign scope requires settlement before another live batch");
    const campaignId = randomUUID();
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 7 * 86400000, maxBytes: 512 * 1024 * 1024 });
    workspace.campaignId = campaignId;
    writeFileSync(join(root, "workspace.json"), JSON.stringify(workspace, null, 2), { mode: 0o600 });
    process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = campaignId;
    const evidence = await GoldenEvidence.attach(client, campaignId);
    const diagnostics = initializeRuntimeDiagnostics({ component: "golden", sink: client });
    if (!diagnostics) throw new Error("The live batch has no diagnostic owner");
    const operation = diagnostics.begin("golden.live_batch", { boundary, protocol, nativeCatalogSha256, browserHelperSha256: helperBuild.sha256, cells: cells.length });
    type CellResult = { id: string; routeSlug: string; workload: WorkloadLevel; variant: string; work: string; traceId: string; passed: boolean; nativeFailure?: NativeScenarioFailure["nativeFailure"]; nativeExecFailure?: NativeExecFailure["nativeExecFailure"]; result?: { terminal: Awaited<ReturnType<typeof runNativeScenario>>; oracle: ReturnType<typeof evaluateWorkload>; commit: ReturnType<typeof verifyArtifactCommit> }; selections?: ReturnType<typeof verifyGoldenModelSelections> | ReturnType<typeof verifyGoldenModelSequence>; receipts?: ReturnType<typeof verifyGoldenToolReceipts>; titles?: ReturnType<typeof verifyGoldenTuiTitles>; progress?: Awaited<ReturnType<GoldenCaptureLane["finishBatch"]>>; error?: ReturnType<typeof problemFor> };
    const captureLanes = new Map<string, GoldenCaptureLane>();
    let failed = false, failure: unknown, results: CellResult[] = [], admission: AdmissionObservation | undefined;
    const nativeThreads = new Set<string>();
    try {
      await evidence.bind(operation.context.traceId);
      await options.onPrepared?.({ work, campaignId, traceId: operation.context.traceId });
      workspace = await restartGoldenLauncher(root);
      const inspection = await diagnostics.run("golden.session_inspection", async () => {
        const ownedPid = workspace.processes.launcher?.pid;
        let lastFailure: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          options.signal.throwIfAborted();
          if (!workspace.processes.launcher || !ownsProcess(workspace.processes.launcher)
            || readLauncherBrowserHostDescriptor(workspace.descriptorPath).pid !== ownedPid) {
            throw new DiagnosticError({ code: "golden_launcher_owner_changed", message: "The hidden launcher owner changed during account inspection", origin: "golden", stage: "session_inspection", retryable: false });
          }
          try { return await inspectLauncherBrowserHost(workspace.descriptorPath, { detectCapabilities: true }); }
          catch (error) {
            lastFailure = error;
            if (attempt === 1) await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000));
          }
        }
        throw new DiagnosticError({ code: "golden_session_inspection_failed", message: "The restarted hidden launcher did not provide account capability evidence", origin: "golden", stage: "session_inspection", retryable: false,
          findings: [{ message: `Two read-only inspections failed; last failure class=${lastFailure instanceof Error ? lastFailure.name : "unknown"}` }],
          evidenceMissing: "The account capability selector did not return a validated result; no native task or model request was admitted.",
        });
      });
      if (typeof inspection.solAvailable !== "boolean" || typeof inspection.proAvailable !== "boolean") throw new Error("The isolated session did not expose its capabilities");
      const available = availableChatGptWebModelRoutes({ solAvailable: inspection.solAvailable, proAvailable: inspection.proAvailable, browserInteractionMode: "automatic" });
      if (cells.some(cell => !available.some(route => route.slug === cell.request.route.slug))) throw new Error("The inspected session does not expose every requested route");
      const switches = new Map(cells.filter(cell => cell.request.variant === "model-switch").map(cell => {
        const from = available.find(route => !isProGeneration(route) && route.interactionMode === "automatic" && route.slug !== cell.request.route.slug);
        if (!from) throw new Error("The inspected account lacks a second permitted route for model-switch preparation");
        return [cell.request.id, { from, to: cell.request.route }];
      }));
      writeFileSync(join(root, "session-inspection.json"), JSON.stringify({ inspectedAt: new Date().toISOString(), ...inspection }, null, 2), { mode: 0o600 });
      results = await operation.run(() => withGoldenRuntime({ workspace, nativeHome: home, protocol, connectorName: source.appName, tunnelId: source.tunnel!.tunnelId, tunnelBinary: source.tunnel!.binaryPath, runtimeKeyFile: source.tunnel!.runtimeKeyFile, capabilities: { solAvailable: inspection.solAvailable!, proAvailable: inspection.proAvailable! }, borrowFromRuntimeHome: sourceHome }, options.signal, async config => {
        const catalogPath = join(work, "web-models.json");
        writeFileSync(catalogPath, JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), config)), { mode: 0o600 });
        writeFileSync(join(home, "config.toml"), goldenNativeConfig({ catalogPath, port: config.port, integration: { nativeConfigPath: join(home, "config.toml"), runtimeHome: workspace.runtimeHome, protocol } }), { mode: 0o600 });
        await initializeGoldenNativeHome({ executable: options.executable, cwd: work, env: nativeEnv, route: cells[0]!.request.route, modelProvider: "golden", signal: options.signal,
          onLaunch: async pid => { await evidence.capture(operation.context.traceId, "transport", JSON.stringify({ nativeHomeInitialization: ownedProcessIdentity(pid) })); },
          onFrame: async frame => { await evidence.capture(operation.context.traceId, "transport", JSON.stringify({ nativeHomeInitialization: frame })); },
          onStderr: async text => { await evidence.capture(operation.context.traceId, "transport", JSON.stringify({ nativeHomeInitializationStderr: text })); },
        });
        const completed = await Promise.allSettled(cells.map(async cell => {
          const cellOperation = diagnostics.begin("golden.native_cell", { variant: cell.request.variant, route: cell.request.route.slug, workload: cell.workload.level }, null, { id: cell.request.id });
          const item: CellResult = { id: cell.request.id, routeSlug: cell.request.route.slug, workload: cell.workload.level, variant: cell.request.variant, work: cell.task, traceId: cellOperation.context.traceId, passed: false };
          const captureLane = new GoldenCaptureLane((category, text) => evidence.capture(item.traceId, category, text));
          captureLanes.set(item.id, captureLane);
          try {
            await evidence.bind(item.traceId);
            await evidence.capture(item.traceId, "oracle", JSON.stringify({ workload: cell.workload, baseline: cell.baseline, nativeCatalogSha256, cellId: cell.request.id }));
            const terminal = await cellOperation.run(() => runNativeScenario({ executable: options.executable, cwd: cell.task, env: nativeEnv, route: cell.request.route, modelProvider: "golden", workload: cell.workload, variant: cell.request.variant, signal: options.signal, timeoutMs: options.turnTimeoutMs,
              beforeGeneration: signal => paceGoldenGeneration(root, signal),
              modelSwitch: switches.get(cell.request.id),
              ...(cell.request.variant === "tool-image" ? { imagePath: join(cell.task, "input/label.png") } : {}),
              onRecord: (category, text, phase, receivedAtMs) => captureLane.record(category, text, phase, receivedAtMs),
              checkpoint: async identity => {
                if (identity.threadId) nativeThreads.add(identity.threadId);
                const checkpoint = { ...identity, traceId: item.traceId, campaignId, work: cell.task };
                writeFileSync(join(cell.task, "../", `${cell.request.id}.checkpoint.json`), JSON.stringify(checkpoint), { mode: 0o600 });
                await cell.request.checkpoint?.(checkpoint);
              },
            }));
            await captureLane.flush();
            if ("scenario" in terminal && terminal.scenario && "titleTasks" in terminal.scenario) for (const title of terminal.scenario.titleTasks) nativeThreads.add(title.threadId);
            const project = cell.workload.level < 3 ? undefined : await runProjectOracle({ workload: cell.workload, work: cell.task, validationRoot: join(work, "validation", cell.request.id), nativeHome: join(work, "validation-native", cell.request.id), nativeExecutable: options.executable, bunExecutable: process.execPath, signal: options.signal,
              onValidation: async workload => { await evidence.capture(item.traceId, "oracle", JSON.stringify({ independentWorkload: workload })); },
              onLaunch: async identity => { await evidence.capture(item.traceId, "oracle", JSON.stringify({ validationProcess: identity })); },
              onOutput: async (stream, text) => { await evidence.capture(item.traceId, "transport", JSON.stringify({ validationStream: stream, text })); },
            });
            const oracle = evaluateWorkload(cell.task, cell.workload, project, cell.request.variant), commit = verifyArtifactCommit({ repository: cell.task, baseline: cell.baseline, paths: oracle.artifacts.map(artifact => artifact.path), env: nativeEnv });
            item.result = { terminal, oracle, commit };
            await evidence.capture(item.traceId, "oracle", JSON.stringify(item.result));
            if (terminal.status !== "completed" || !terminal.threadId || !terminal.toolItems) throw new DiagnosticError({ code: "golden_native_evidence_missing", message: "Native workload lacks its required completed terminal, task identity or tool evidence", origin: "golden-native", stage: "native_acceptance" });
            if (!oracle.passed || !commit.passed) throw new DiagnosticError({ code: "golden_artifact_rejected", message: "The native task completed but its artifacts did not satisfy independent acceptance", origin: "golden-oracle", stage: "artifact_acceptance", findings: [...oracle.failures, ...oracle.pendingChecks, ...commit.failures].map(message => ({ message })) });
          } catch (error) {
            try { await captureLane.flush(); }
            catch (captureError) { if (captureError !== error) error = new AggregateError([error, captureError], "Native work and retained capture did not both settle"); }
            const titleFailure = findNativeTuiTitleFailure(error);
            if (titleFailure) nativeThreads.add(titleFailure.threadId);
            item.error = problemFor(error); cellOperation.problem(error);
            const nativeFailure = findNativeScenarioFailure(error);
            if (nativeFailure) {
              item.nativeFailure = nativeFailure.nativeFailure;
              retainLiveAdmissionFailure(root, join(cell.task, "../", `${cell.request.id}.admission.json`), item.nativeFailure);
              await evidence.capture(item.traceId, "transport", JSON.stringify({ nativeFailure: item.nativeFailure }));
            }
            const execFailure = findNativeExecFailure(error);
            if (execFailure) {
              item.nativeExecFailure = execFailure.nativeExecFailure;
              nativeThreads.add(execFailure.nativeExecFailure.outcome.threadId);
              await evidence.capture(item.traceId, "transport", JSON.stringify({ nativeExecFailure: item.nativeExecFailure }));
            }
          }
          finally { cellOperation.end(item.error ? "failed" : "succeeded"); }
          return item;
        }));
        const rejected = completed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), "Owned native cells did not settle");
        return completed.map(result => (result as PromiseFulfilledResult<CellResult>).value);
      }));
      const observed = await readGoldenEvents(client, campaignId, { observerTraceId: operation.context.traceId });
      for (const item of results) {
        if (item.error || !item.result?.terminal.threadId) continue;
        const cell = cells.find(cell => cell.request.id === item.id)!;
        const nativeEvents = selectGoldenNativeThreadEvents(observed.events, item.result.terminal.threadId);
        const routes = switches.get(cell.request.id);
        if (routes) {
          const terminal = item.result.terminal;
          const scenario = "scenario" in terminal ? terminal.scenario : undefined;
          if (!scenario || !("modelSwitch" in scenario) || scenario.modelSwitch?.from !== routes.from.slug || scenario.modelSwitch.to !== routes.to.slug || scenario.turns.length !== 2 || scenario.turns.some(turn => turn.status !== "completed")) throw new Error("Model switching lacks its two completed native turns and route identities");
          item.selections = verifyGoldenModelSequence(nativeEvents.events, terminal.threadId!, [{ turnId: scenario.turns[0]!.id, route: routes.from }, { turnId: scenario.turns[1]!.id, route: routes.to }]);
        } else item.selections = verifyGoldenModelSelections(nativeEvents.events, cell.request.route, finiteNativeScenarios[cell.request.variant]);
        item.receipts = verifyGoldenToolReceipts(nativeEvents.events, goldenScenarioTerminations(cell.request.variant, item.result.terminal));
        const terminal = item.result.terminal;
        if (cell.request.variant === "plan-tui-execute" && "scenario" in terminal && terminal.scenario && "titleTasks" in terminal.scenario) item.titles = verifyGoldenTuiTitles(observed.events, terminal.threadId!, terminal.scenario.titleTasks, cell.request.route);
        item.passed = item.selections.passed && item.receipts.passed && (cell.request.variant !== "plan-tui-execute" || item.titles?.passed === true);
        // Persist observed intervals before any campaign may turn them into a duration claim.
        // Finite cells never credit level-five time; that requires a separate sustained owner.
        item.progress = await captureLanes.get(item.id)!.finishBatch(false);
        await evidence.capture(item.traceId, "oracle", JSON.stringify({ nativeTraceIds: nativeEvents.traceIds, nativeTurnIds: nativeEvents.turnIds, selections: item.selections, receipts: item.receipts, ...(item.titles ? { titles: item.titles } : {}), progress: item.progress, passed: item.passed }));
      }
    } catch (error) {
      failed = true; failure = error; operation.problem(error);
      try { await evidence.capture(operation.context.traceId, "oracle", JSON.stringify({ batchFailure: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "UnknownFailure" } })); }
      catch (captureError) { operation.problem(captureError, "The batch failure detail could not be captured"); }
    }
    finally {
      // Capture, oracle and cleanup failures must not bypass an observed account constraint.
      try {
        admission = await retainLiveProviderAdmission(client, { root, campaignId, observerTraceId: operation.context.traceId, ownedThreadIds: [...nativeThreads], evidencePath: join(work, "provider-admission.json") });
        if (admission) {
          const constraint = new GoldenAdmissionSuspended(admission);
          operation.problem(constraint); failure ??= constraint; failed = true;
        }
      } catch (error) {
        operation.problem(error, "Native provider admission evidence could not be retained");
        failure = failure ? new AggregateError([failure, error], "Live work and admission evidence did not settle") : error; failed = true;
      }
      operation.end(failed || results.some(item => !item.passed) ? "failed" : "succeeded"); await closeRuntimeDiagnostics();
    }
    const pending = { boundary, protocol, work, campaignId, nativeHome: home, nativeCatalogSha256, cells: results, passed: false, incomplete: true, evidenceExport: "pending", diagnostics: await client.status(), ...(failed ? { problem: problemFor(failure) } : {}), ...(admission ? { admission } : {}) };
    writeFileSync(join(work, "result.json"), JSON.stringify(pending, null, 2), { mode: 0o600 });
    const exported = await finishGoldenEvidence(evidence, client, invocation, operation.context.traceId, join(work, "evidence.zip"));
    const summary = { ...pending, cells: results.map(item => ({ ...item, passed: item.passed && !failed && !exported.incomplete })), evidenceExport: "complete", evidence: exported.destination, bundleSha256: exported.bundleSha256, incomplete: exported.incomplete, passed: !failed && !exported.incomplete && results.length === cells.length && results.every(item => item.passed) };
    writeFileSync(join(work, "result.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
    return summary;
  } finally { await client.close(); }
}

if (import.meta.main) {
  const spec = z.object({
    protocol: z.enum(["native", "compatibility-v1"]).optional(), turnTimeoutMs: z.number().int().positive().max(86400000),
    cells: z.array(z.object({ id: z.string().regex(/^[a-f\d]{64}$/), routeSlug: z.string().min(1).max(128), workload: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), variant: z.enum(Object.keys(finiteNativeScenarios) as [FiniteNativeScenario, ...FiniteNativeScenario[]]) }).strict()).min(1).max(2),
  }).strict().parse(JSON.parse(readFileSync(process.argv[5] ?? "", "utf8")));
  const controller = new AbortController(), stop = () => controller.abort(new Error("Live batch observation cancelled"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const result = await runLiveBatch({ ...spec, root: process.argv[2] ?? "context/golden/live", executable: process.argv[3] ?? "/usr/lib/chatgpt/resources/codex", sourceHome: process.argv[4] ?? join(homedir(), ".codex-chatgpt-web"), signal: controller.signal });
    console.log(JSON.stringify({ work: result.work, campaignId: result.campaignId, passed: result.passed, incomplete: result.incomplete, evidence: result.evidence, bundleSha256: result.bundleSha256, problem: result.problem, cells: result.cells.map(cell => ({ id: cell.id, route: cell.routeSlug, passed: cell.passed, error: cell.error, threadId: cell.result?.terminal.threadId, selections: cell.selections })) }));
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
