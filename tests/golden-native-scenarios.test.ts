import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ownedNativeActivity, runNativeScenario } from "../scripts/golden/native-scenarios";
import { GOLDEN_UNICODE_WITNESS, createWorkload, largeHistoryWitness, materializeWorkload } from "../scripts/golden/workloads";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { GoldenAppServer, initializeGoldenNativeHome } from "../scripts/golden/app-server";
import { findNativeExecFailure, runNativeExec } from "../scripts/golden/exec";
import { extractCodexTurnIdentityFromBody } from "../src/adapters/chatgpt-web/environment";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { DiagnosticError, problemFor } from "../src/diagnostics/problems";
import { GoldenQueue } from "../scripts/golden/queue";
import { retainLiveProviderAdmission } from "../scripts/golden/live-batch";
import { ownsProcess, type OwnedProcess } from "../scripts/golden/workspace";
import { goldenNativeEnvironment } from "../scripts/golden/runtime-config";
import { bridgeToResponsesSSE } from "../src/bridge";

test("Unicode scenario submits an exact witness requirement in one owned native turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-unicode-scenario-")), peer = join(root, "peer"), promptPath = join(root, "prompt.txt");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {writeFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
writeFileSync(${JSON.stringify(promptPath)},prompt);
console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"turn.completed"}));
});
`, { mode: 0o700 });
  try {
    const result = await runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload: createWorkload({ level: 1, seed: "unicode-lifecycle", batch: 0 }), variant: "unicode", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} });
    expect(result).toMatchObject({ status: "completed", variant: "unicode", threadId: "11111111-1111-7111-8111-111111111111" });
    const prompt = readFileSync(promptPath, "utf8");
    expect(prompt).toContain("output/unicode.txt");
    expect(prompt).toContain(GOLDEN_UNICODE_WITNESS);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("large-history continuation retains an early fact without repeating it in the second prompt", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-large-history-")), peer = join(root, "peer"), log = join(root, "prompts.jsonl");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
appendFileSync(${JSON.stringify(log)},JSON.stringify({resumed:process.argv.includes("resume"),prompt})+"\\n");
if(process.env.EARLY_WRITE==="1"&&!process.argv.includes("resume")){mkdirSync(${JSON.stringify(join(root,"output"))},{recursive:true});writeFileSync(${JSON.stringify(join(root,"output/history-witness.txt"))},"premature\\n");}
console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"turn.completed"}));
});

`, { mode: 0o700 });
  const workload = createWorkload({ level: 1, seed: "large-history-lifecycle", batch: 0 });
  try {
    const result = await runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "large-history", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} });
    expect(result).toMatchObject({ status: "completed", variant: "large-history", threadId: "11111111-1111-7111-8111-111111111111", preparation: { status: "completed" } });
    const prompts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { resumed: boolean; prompt: string });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.resumed).toBe(false);
    expect(prompts[0]!.prompt.length).toBeGreaterThan(20_000);
    expect(prompts[0]!.prompt).toContain(largeHistoryWitness(workload));
    expect(prompts[1]!.resumed).toBe(true);
    expect(prompts[1]!.prompt).toContain("output/history-witness.txt");
    expect(prompts[1]!.prompt).not.toContain(largeHistoryWitness(workload));
    await expect(runNativeScenario({ executable: peer, cwd: root, env: { EARLY_WRITE: "1" }, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "large-history", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} })).rejects.toThrow("Large-history preparation wrote its witness before the retained continuation");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native compaction continues the same task only after its own compact item and terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-compaction-")), peer = join(root, "peer"), log = join(root, "turns.jsonl");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const send=message=>process.stdout.write(JSON.stringify(message)+"\\n");
let buffer="",n=0;
process.stdin.on("data",chunk=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf("\\n");if(i<0)break;const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
if(m.method==="initialize")send({id:m.id,result:{userAgent:"fixture"}});
if(m.method==="thread/start")send({id:m.id,result:{thread:{id:"thread-one"},model:m.params.model,modelProvider:"openai",reasoningEffort:"low",cwd:m.params.cwd}});
if(m.method==="turn/start"){
 const id="turn-"+(++n);appendFileSync(${JSON.stringify(log)},JSON.stringify({threadId:m.params.threadId,text:m.params.input[0].text})+"\\n");
 send({method:"turn/started",params:{threadId:"thread-one",turn:{id,status:"inProgress",items:[]}}});
 send({method:"turn/completed",params:{threadId:"thread-one",turn:{id,status:"completed",items:[]}}});
 send({id:m.id,result:{turn:{id,status:"inProgress",items:[]}}});
}
if(m.method==="thread/compact/start"){
 const id="compact-1",item={id:"compaction-item-1",type:"contextCompaction"};
 send({method:"turn/started",params:{threadId:"thread-one",turn:{id,status:"inProgress",items:[]}}});
 if(process.env.FAIL_COMPACT==="1"){
  send({method:"turn/completed",params:{threadId:"thread-one",turn:{id,status:"failed",items:[],error:{codexErrorInfo:"other"}}}});
  send({id:m.id,result:{}});continue;
 }
 send({method:"item/completed",params:{threadId:"thread-one",turnId:id,item}});
 send({method:"turn/completed",params:{threadId:"thread-one",turn:{id,status:"completed",items:[item]}}});
 send({id:m.id,result:{}});
}
}});
process.stdin.on("end",()=>process.exit(0));
`, { mode: 0o700 });
  const workload = createWorkload({ level: 1, seed: "native-compaction", batch: 0 });
  try {
    let generationReservations = 0;
    const result = await runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "compaction", signal: new AbortController().signal, timeoutMs: 2000,
      beforeGeneration: async () => { generationReservations++; },
      onRecord: async () => {}, checkpoint: () => {} });
    expect(generationReservations).toBe(3);
    expect(result).toMatchObject({ status: "completed", threadId: "thread-one", scenario: { turns: [{ id: "turn-1" }, { id: "turn-2" }], compaction: { turnId: "compact-1", itemId: "compaction-item-1", turn: { status: "completed" } } } });
    const prompts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { text: string });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.text).toContain(largeHistoryWitness(workload));
    expect(prompts[1]!.text).toContain("output/history-witness.txt");
    expect(prompts[1]!.text).not.toContain(largeHistoryWitness(workload));
    await expect(runNativeScenario({ executable: peer, cwd: root, env: { FAIL_COMPACT: "1" }, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "compaction", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} })).rejects.toMatchObject({ code: "native_scenario_failed", nativeFailure: { threadId: "thread-one", turns: [{ status: "completed" }, { id: "compact-1", status: "failed" }] } });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native image scenario attaches the exact generated PNG and retains its trusted digest", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-image-")), peer = join(root, "peer"), log = join(root, "launch.json");
  const workload = createWorkload({ level: 1, seed: "native-image", batch: 0, formatCoverage: "all" });
  materializeWorkload(root, workload);
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {writeFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
writeFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),prompt}));
console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"}));
console.log(JSON.stringify({type:"turn.started"}));
console.log(JSON.stringify({type:"turn.completed"}));
});
`, { mode: 0o700 });
  const imagePath = join(root, "input/label.png");
  const options = { executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "tool-image", signal: new AbortController().signal, timeoutMs: 2000,
    onRecord: async () => {}, checkpoint: () => {} };
  try {
    await expect(runNativeScenario({ ...options, imagePath: join(root, "input/other.png") })).rejects.toThrow("exact materialized fixture");
    const result = await runNativeScenario({ ...options, imagePath });
    expect(result).toMatchObject({ status: "completed", variant: "tool-image", attachedImageSha256: createHash("sha256").update(readFileSync(imagePath)).digest("hex") });
    const launched = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; prompt: string };
    expect(launched.args.slice(-3)).toEqual(["--image", imagePath, "-"]);
    expect(launched.prompt).toContain("image attached to this native turn");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native progress and tool credit require the exact owned task and turn", () => {
  const owner = { threadId: "owned-thread", turnId: "owned-turn" };
  const frame = (threadId: string, turnId: string, method: string, extra: Record<string, unknown> = {}) => ({
    direction: "received", message: { method, params: { threadId, turnId, ...extra } },
  });
  expect(ownedNativeActivity(frame("owned-thread", "owned-turn", "item/completed", { item: { type: "mcpToolCall" } }), owner)).toEqual({ tool: true, phase: "tools" });
  expect(ownedNativeActivity(frame("foreign-thread", "owned-turn", "item/completed", { item: { type: "mcpToolCall" } }), owner)).toEqual({ tool: false, phase: undefined });
  expect(ownedNativeActivity(frame("owned-thread", "foreign-turn", "item/reasoning/summaryTextDelta", { delta: "progress" }), owner)).toEqual({ tool: false, phase: undefined });
  expect(ownedNativeActivity({ ...frame("owned-thread", "owned-turn", "item/completed", { item: { type: "mcpToolCall" } }), direction: "sent" }, owner)).toEqual({ tool: false, phase: undefined });
});

for (const outcome of ["completed", "failed", "missing"] as const) for (const variant of outcome === "completed" ? ["resumed"] : ["resumed", "archived-history"]) test(`${variant} scenario requires settled preparation before reopening its exact task: ${outcome}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-resume-scenario-")), peer = join(root, "peer"), log = join(root, "launches.jsonl");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {appendFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
const args=process.argv.slice(2), resumed=args.includes("resume");
appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,args,prompt})+"\\n");
const send=value=>console.log(JSON.stringify(value));
send({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"});send({type:"turn.started"});
if(resumed || ${JSON.stringify(outcome)}!=="missing")send({type:resumed || ${JSON.stringify(outcome)}==="completed"?"turn.completed":"turn.failed"});
});

`, { mode: 0o700 });
  const nativePids: number[] = [];
  const run = () => runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload: createWorkload({ level: 1, seed: "resume-lifecycle", batch: 0 }), variant, signal: new AbortController().signal, timeoutMs: 2000,
    onRecord: async () => {}, checkpoint: value => { nativePids.push(value.native.pid); },
  });
  try {
    if (outcome === "completed") {
      const result = await run();
      expect(result).toMatchObject({ status: "completed", threadId: "11111111-1111-7111-8111-111111111111", variant: "resumed" });
      const launches = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(launches).toHaveLength(2);
      expect(launches[0].args).not.toContain("resume");
      expect(launches[1].args.slice(-3)).toEqual(["resume", result.threadId, "-"]);
      expect(new Set(nativePids).size).toBe(2);
      expect(launches[0].prompt).not.toBe(launches[1].prompt);
    } else {
      const failure = await run().catch(error => error);
      if (outcome === "failed") expect(failure).toMatchObject({ code: "native_exec_failed", nativeExecFailure: { phase: "preparation", outcome: { threadId: "11111111-1111-7111-8111-111111111111", status: "failed", terminal: { type: "turn.failed" }, exit: { code: 0, signal: null } } } });
      else expect(failure).toMatchObject({ code: "native_completion_missing" });
      expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an archive restoration with a different identity cannot submit resumed work", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-archive-owner-")), peer = join(root, "peer"), log = join(root, "launches.jsonl");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2), threadId="11111111-1111-7111-8111-111111111111";
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+"\\n");
const send=value=>console.log(JSON.stringify(value));let buffer="";
if(args[0]==="app-server")process.stdin.on("data",chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf("\\n"))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(request.id===undefined)continue;const result=request.method==="initialize"?{userAgent:"fixture"}:request.method==="thread/list"?{data:[{id:threadId}]}:request.method==="thread/unarchive"?{thread:{id:"22222222-2222-7222-8222-222222222222"}}:{};send({id:request.id,result});}});
else {process.stdin.resume();process.stdin.on("end",()=>{send({type:"thread.started",thread_id:threadId});send({type:"turn.started"});send({type:"turn.completed"});});}
`, { mode: 0o700 });
  try {
    await expect(runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload: createWorkload({ level: 1, seed: "archive-owner", batch: 0 }), variant: "archived-history", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {},
    })).rejects.toThrow("not restored with the same identity");
    const launches = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(launches.map(args => args[0])).toEqual(["exec", "app-server"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native exec preparation preserves failure identity and correlated account admission despite incomplete content", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-exec-limit-")), home = join(root, "home"), executable = process.env.CODEX_TEST_PROFILE_BINARY!;
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize native fixture repository");
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", join(root, "diagnostics"), "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "runtime", target: "fixture", environment: "test" });
  const campaignId = randomUUID(), route = CHATGPT_WEB_MODEL_ROUTES[0]!, identities: { threadId?: string; turnId?: string }[] = [], launches: OwnedProcess[] = [];
  const queue = new GoldenQueue(join(root, "campaign.sqlite"), { snapshot: { inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64), capabilities: { solAvailable: true, proAvailable: false } }, implementationSha256: "b".repeat(64) });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const identity = extractCodexTurnIdentityFromBody(await request.json()); identities.push({ threadId: identity.threadId, turnId: identity.turnId });
    if (!identity.threadId || !identity.turnId) return new Response("Native fixture requires actual task metadata", { status: 400 });
    const operation = diagnostics.begin("http.responses", {}, null, { id: `${identity.threadId}:${identity.turnId}` });
    await client.contentCapture({ action: "bind", campaignId, traceId: operation.context.traceId });
    operation.run(() => diagnostics.problem(new DiagnosticError({ code: "rate_limit_exceeded", message: "Synthetic account limit", httpStatus: 429, origin: "chatgpt-http" })));
    operation.end("failed");
    await client.contentCapture({ action: "omit", campaignId, traceId: operation.context.traceId, reason: "surface-excluded" });
    return Response.json({ error: { message: "Synthetic account limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }, { status: 429 });
  } });
  writeFileSync(join(home, "config.toml"), `[model_providers.fixture]\nname="Local native failure fixture"\nbase_url="http://127.0.0.1:${server.port}"\nwire_api="responses"\nrequires_openai_auth=false\nstream_max_retries=0\nrequest_max_retries=0\n[analytics]\nenabled=false\n`);
  try {
    await client.contentCapture({ action: "start", campaignId, acknowledged: true, until: Date.now() + 120000 });
    const observer = diagnostics.begin("golden.acceptance", {}, null);
    await client.contentCapture({ action: "bind", campaignId, traceId: observer.context.traceId });
    const error = await runNativeScenario({ executable, cwd: root, env: goldenNativeEnvironment(root, home, executable), route, modelProvider: "fixture", variant: "resumed", workload: createWorkload({ level: 1, seed: "native-exec-limit", batch: 0 }), timeoutMs: 15000, signal: new AbortController().signal,
      onRecord: async () => {}, checkpoint: value => { if (!launches.some(item => item.pid === value.native.pid)) launches.push(value.native); },
    }).catch(error => error);
    const failure = findNativeExecFailure(new AggregateError([new Error("Independent fixture cleanup failure"), error]));
    expect(problemFor(error)).toMatchObject({ code: "native_exec_failed", stage: "native_preparation", origin: "native" });
    expect(failure).toMatchObject({ nativeExecFailure: { phase: "preparation", outcome: { status: "failed", terminal: { type: "turn.failed" }, exit: { code: 1, signal: null } } } });
    expect(identities).toHaveLength(1);
    expect(failure!.nativeExecFailure.outcome.threadId).toBe(identities[0]!.threadId!);
    expect(launches).toHaveLength(1);
    expect(ownsProcess(launches[0]!)).toBeFalse();
    const input = { root, campaignId, observerTraceId: observer.context.traceId, ownedThreadIds: [failure!.nativeExecFailure.outcome.threadId], evidencePath: join(root, "provider-admission.json") };
    expect(await retainLiveProviderAdmission(client, { ...input, ownedThreadIds: [randomUUID()] })).toBeUndefined();
    expect(await retainLiveProviderAdmission(client, input)).toMatchObject({ code: "rate_limit_exceeded", ...identities[0] });
    expect(queue.summary().admissionHold).toMatchObject({ code: "rate_limit_exceeded", ...identities[0] });
    expect(findNativeExecFailure(new Error("rate_limit_exceeded"))).toBeUndefined();
    observer.end();
  } finally { await server.stop(true); await diagnostics.close(); await client.close(); queue.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);


test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("serial native home initialization admits concurrent exec and app-server consumers without generating work", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-home-")), home = join(root, "home"), executable = process.env.CODEX_TEST_PROFILE_BINARY!;
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize native fixture repository");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!; let requests = 0, stderr = "";
  const initializationMethods: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    await request.arrayBuffer(); requests++;
    async function* output() {
      yield { type: "text_delta" as const, text: "Synthetic concurrent native startup.", phase: "final_answer" as const };
      yield { type: "done" as const, endTurn: true };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `[model_providers.fixture]\nname="Local native startup fixture"\nbase_url="http://127.0.0.1:${server.port}"\nwire_api="responses"\nrequires_openai_auth=false\n[analytics]\nenabled=false\n`);
  const input = { executable, cwd: root, env: goldenNativeEnvironment(root, home, executable), route, modelProvider: "fixture", onStderr: (text: string) => { stderr = (stderr + text).slice(-8192); } };
  try {
    await initializeGoldenNativeHome({ ...input, signal: new AbortController().signal, onLaunch: () => {}, onFrame: frame => { if (frame.direction === "sent") initializationMethods.push(frame.message.method); } });
    expect(initializationMethods).toEqual(["initialize", "initialized"]);
    expect(requests).toBe(0);
    const app = new GoldenAppServer({ ...input, onFrame: () => {} });
    const results = await Promise.allSettled([
      (async () => { try { await app.initialize(); await app.openThread(); const turn = await app.startTurn({ text: "Return the synthetic response." }); return await app.waitForCompletion(turn.id, { timeoutMs: 15000 }); } finally { await app.close(); } })(),
      runNativeExec({ ...input, prompt: "Return the synthetic response.", timeoutMs: 15000, onInput: () => {}, onLaunch: () => {}, onEvent: () => {} }),
    ]);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), `Native startup fixture failed: ${stderr}`);
    expect(results.map(result => result.status === "fulfilled" && result.value.status)).toEqual(["completed", "completed"]);
    expect(requests).toBe(2);
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 120000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("native archive and restore preserves the exact task history for exec resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-archive-")), home = join(root, "home"), executable = process.env.CODEX_TEST_PROFILE_BINARY!;
  mkdirSync(home);
  if (Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode !== 0) throw new Error("Could not initialize native fixture repository");
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!, bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    bodies.push(await request.text());
    async function* output() {
      yield { type: "text_delta" as const, text: "Synthetic archived-history witness.", phase: "final_answer" as const };
      yield { type: "done" as const, endTurn: true };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `[model_providers.fixture]\nname="Local native archive fixture"\nbase_url="http://127.0.0.1:${server.port}"\nwire_api="responses"\nrequires_openai_auth=false\n[analytics]\nenabled=false\n`);
  const input = { executable, cwd: root, env: goldenNativeEnvironment(root, home, executable), route, modelProvider: "fixture", onStderr: () => {} };
  const methods: unknown[] = [];
  try {
    const result = await runNativeScenario({ ...input, variant: "archived-history", workload: createWorkload({ level: 1, seed: "archived-history", batch: 0 }), timeoutMs: 15000, signal: new AbortController().signal, checkpoint: () => {},
      onRecord: async (category, text) => {
        if (category !== "transport") return;
        try { const frame = JSON.parse(text); if (frame.direction === "sent") methods.push(frame.message.method); } catch { /* Synthetic native stderr has no JSON contract. */ }
      },
    });
    expect(result).toMatchObject({ status: "completed", preparation: { status: "completed", threadId: result.threadId }, archive: { threadId: result.threadId, archived: true, restored: true } });
    expect(methods).toEqual(["initialize", "initialized", "thread/archive", "thread/list", "thread/unarchive", "thread/list"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("Synthetic archived-history witness.");
  } finally { await server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 120000);
