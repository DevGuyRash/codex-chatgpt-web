import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { exactNativeCommand, ownedNativeActivity, runNativeScenario } from "../scripts/golden/native-scenarios";
import { GOLDEN_UNICODE_WITNESS, GOLDEN_RECOVERABLE_FAILURE_FILE, GOLDEN_RECOVERABLE_FAILURE_CONTENT, GOLDEN_LARGE_TOOL_RESULT_FILE, createWorkload, largeToolResultContent, largeToolResultOutput, largeToolResultSha256, largeHistoryWitness, retainedConversationRevision, materializeWorkload } from "../scripts/golden/workloads";
import { CHATGPT_WEB_MODEL_ROUTES, CHATGPT_WEB_LUNA_MODEL_ROUTES } from "../src/chatgpt-web-models";
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
import { GoldenCaptureLane } from "../scripts/golden/capture-lane";

for (const method of ["turn/start", "turn/steer", "thread/compact/start"] as const) {
  for (const captureFails of [false, true]) test(`app-server ${method} waits for durable input capture (failure=${captureFails})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "golden-native-input-fence-")), peer = join(root, "peer"), sent = join(root, "sent");
    mkdirSync(join(root, ".git"));
    writeFileSync(peer, `#!${process.execPath}
import {appendFileSync} from "node:fs";
const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");
const turn=(id,status,items=[])=>({id,status,items});
let buffer="",n=0;
process.stdin.on("data",chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf("\\n");if(i<0)break;const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
 if(m.method===${JSON.stringify(method)})appendFileSync(${JSON.stringify(sent)},m.method+"\\n");
 if(m.method==="initialize")send({id:m.id,result:{userAgent:"fixture"}});
 if(m.method==="thread/start")send({id:m.id,result:{thread:{id:"thread-one"},model:m.params.model,modelProvider:"openai",reasoningEffort:"low",cwd:m.params.cwd}});
 if(m.method==="turn/start"){
  const id="turn-"+(++n);send({method:"turn/started",params:{threadId:"thread-one",turn:turn(id,"inProgress")}});
  send({id:m.id,result:{turn:turn(id,"inProgress")}});
  if(${JSON.stringify(method)}==="turn/steer")send({method:"item/agentMessage/delta",params:{threadId:"thread-one",turnId:id,delta:"Working"}});
  else send({method:"turn/completed",params:{threadId:"thread-one",turn:turn(id,"completed")}});
 }
 if(m.method==="turn/steer"){
  send({id:m.id,result:{turnId:"turn-1"}});
  send({method:"turn/completed",params:{threadId:"thread-one",turn:turn("turn-1","completed")}});
 }
 if(m.method==="thread/compact/start"){
  const id="compact-one",item={id:"compact-item",type:"contextCompaction"};
  send({method:"turn/started",params:{threadId:"thread-one",turn:turn(id,"inProgress")}});
  send({method:"item/completed",params:{threadId:"thread-one",turnId:id,item}});
  send({method:"turn/completed",params:{threadId:"thread-one",turn:turn(id,"completed",[item])}});
  send({id:m.id,result:{}});
 }
}});process.stdin.on("end",()=>process.exit(0));
`, { mode: 0o700 });
    let release!: () => void, entered!: () => void, count = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const capturing = new Promise<void>(resolve => { entered = resolve; });
    const categories: string[] = [];
    const lane = new GoldenCaptureLane(async (category, text) => {
      const frame = JSON.parse(text);
      if (frame.direction === "sent" && frame.message.method === method) {
        categories.push(category); entered(); await held;
        if (captureFails) throw new Error("Input capture failed");
      }
      return { traceId: "a".repeat(32), kind: "attachment", id: `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`, sha256: "b".repeat(64) };
    });
    const result = runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!,
      workload: createWorkload({ level: 1, seed: "durable-native-input", batch: 0 }),
      variant: method === "turn/steer" ? "steer-generation" : method === "thread/compact/start" ? "compaction" : "continued",
      signal: new AbortController().signal, timeoutMs: 2000, onRecord: (...args) => lane.record(...args), checkpoint: () => {} });
    void result.catch(() => {});
    try {
      await Promise.race([capturing, result.then(() => { throw new Error("Native scenario completed before the selected input capture"); })]);
      await Bun.sleep(20);
      expect(existsSync(sent)).toBe(false);
      expect(categories).toEqual(["prompt"]);
      release();
      if (captureFails) {
        await expect(result).rejects.toThrow("Input capture failed");
        await expect(lane.flush()).rejects.toThrow("Input capture failed");
        expect(existsSync(sent)).toBe(false);
      } else {
        expect(await result).toMatchObject({ status: "completed", threadId: "thread-one" });
        await lane.flush();
        expect(readFileSync(sent, "utf8").trim().split("\n")).toHaveLength(method === "turn/start" ? 2 : 1);
      }
    } finally { release(); await result.catch(() => {}); rmSync(root, { recursive: true, force: true }); }
  }, 5000);
}

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

test("recoverable tool failure observes one actual nonzero native command before completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-tool-failure-")), peer = join(root, "peer");
  mkdirSync(join(root, ".git"));
  const workload = createWorkload({ level: 1, seed: "recoverable-tool-failure", batch: 0 });
  workload.files[GOLDEN_RECOVERABLE_FAILURE_FILE] = GOLDEN_RECOVERABLE_FAILURE_CONTENT;
  materializeWorkload(root, workload);
  writeFileSync(peer, `#!${process.execPath}
import {spawnSync} from "node:child_process";
const send=value=>console.log(JSON.stringify(value));
let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{
 const command=process.env.WRAPPED_COMMAND==="1"?"/usr/bin/zsh -c 'bash input/expected-failure.sh'":"bash input/expected-failure.sh";
 const result=spawnSync("bash",["input/expected-failure.sh"],{cwd:process.cwd(),encoding:"utf8"});
 send({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"});
 send({type:"turn.started"});
 send({type:"item.completed",item:{type:"command_execution",id:"expected-failure",command,exit_code:result.status,aggregated_output:result.stderr}});
 send({type:"turn.completed"});
});
`, { mode: 0o700 });
  try {
    const result = await runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "tool-failure", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} });
    expect(result).toMatchObject({ status: "completed", variant: "tool-failure", toolItems: 1, failureWitness: { count: 1, expectedExitCode: 17 } });
    const wrapped = await runNativeScenario({ executable: peer, cwd: root, env: { WRAPPED_COMMAND: "1" }, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "tool-failure", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} });
    expect(wrapped).toMatchObject({ status: "completed", failureWitness: { count: 1, expectedExitCode: 17 } });
    await expect(runNativeScenario({ executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload: createWorkload({ level: 1, seed: "missing-failure-fixture", batch: 0 }), variant: "tool-failure", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} })).rejects.toThrow("runner-owned input fixture");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native shell wrapper recognition requires one exact command body", () => {
  const expected = "bash input/expected-failure.sh";
  expect(exactNativeCommand(expected, expected)).toBe(true);
  expect(exactNativeCommand("/usr/bin/zsh -c 'bash input/expected-failure.sh'", expected)).toBe(true);
  expect(exactNativeCommand('bash -lc "bash input/expected-failure.sh"', expected)).toBe(true);
  for (const command of ["/usr/bin/zsh -c 'bash input/expected-failure.sh && true'", "/usr/bin/zsh -c 'echo x; bash input/expected-failure.sh'", "bash input/expected-failure.sh; true", "/usr/bin/zsh -c 'bash input/other.sh'", "not-zsh -c 'bash input/expected-failure.sh'"]) {
    expect(exactNativeCommand(command, expected)).toBe(false);
  }
});

test("large tool result coordinator observes one complete native command instead of prose or a truncated result", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-large-tool-result-")), peer = join(root, "peer"), promptPath = join(root, "prompt.txt");
  const workload = createWorkload({ level: 1, seed: "large-tool-result", batch: 0 });
  workload.files[GOLDEN_LARGE_TOOL_RESULT_FILE] = largeToolResultContent(workload);
  materializeWorkload(root, workload);
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {spawnSync} from "node:child_process";
import {writeFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
 writeFileSync(${JSON.stringify(promptPath)},prompt);
 const command=process.env.WRAPPED_COMMAND==="1"?"/usr/bin/zsh -c 'bun input/large-tool-result.ts'":"bun input/large-tool-result.ts";
 const run=spawnSync(process.execPath,["input/large-tool-result.ts"],{cwd:process.cwd(),encoding:"utf8",maxBuffer:1024*1024});
 const output=process.env.TRUNCATE==="1"?run.stdout.slice(0,1024):run.stdout;
 const send=value=>console.log(JSON.stringify(value));
 send({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"});send({type:"turn.started"});
 if(process.env.DECOY==="1")send({type:"item.completed",item:{type:"command_execution",id:"mentioned-file",command:"cat input/large-tool-result.ts",exit_code:0,aggregated_output:"Inspected the fixture path"}});
 const item={type:"item.completed",item:{type:"command_execution",id:"large-result",command,exit_code:run.status,aggregated_output:output}};
 send(item);if(process.env.DUPLICATE==="1")send(item);
 send({type:"turn.completed"});
});
`, { mode: 0o700 });
  const options = { executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "large-tool-result", signal: new AbortController().signal, timeoutMs: 2000,
    onRecord: async () => {}, checkpoint: () => {} };
  try {
    const result = await runNativeScenario(options);
    expect(result).toMatchObject({ status: "completed", variant: "large-tool-result", toolItems: 1,
      largeResultWitness: { invocations: 1, count: 1, bytes: Buffer.byteLength(largeToolResultOutput(workload)), sha256: largeToolResultSha256(workload) } });
    expect(readFileSync(promptPath, "utf8")).toContain("max_output_tokens 20000");
    const truncated = await runNativeScenario({ ...options, env: { TRUNCATE: "1" } });
    expect("largeResultWitness" in truncated ? truncated.largeResultWitness : undefined).toMatchObject({ invocations: 1, count: 0 });
    const decoy = await runNativeScenario({ ...options, env: { DECOY: "1" } });
    expect("largeResultWitness" in decoy ? decoy.largeResultWitness : undefined).toMatchObject({ invocations: 1, count: 1 });
    const wrapped = await runNativeScenario({ ...options, env: { WRAPPED_COMMAND: "1", DECOY: "1" } });
    expect("largeResultWitness" in wrapped ? wrapped.largeResultWitness : undefined).toMatchObject({ invocations: 1, count: 1 });
    const duplicated = await runNativeScenario({ ...options, env: { DUPLICATE: "1" } });
    expect("largeResultWitness" in duplicated ? duplicated.largeResultWitness : undefined).toMatchObject({ invocations: 2, count: 2 });
    const missing = { ...workload, files: { ...workload.files, [GOLDEN_LARGE_TOOL_RESULT_FILE]: "changed" } };
    await expect(runNativeScenario({ ...options, workload: missing })).rejects.toThrow("runner-owned input fixture");
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

test("retained conversation change uses one native task and requires the second instruction", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-retained-change-")), peer = join(root, "peer"), log = join(root, "prompts.jsonl");
  mkdirSync(join(root, ".git"));
  writeFileSync(peer, `#!${process.execPath}
import {appendFileSync,mkdirSync,writeFileSync} from "node:fs";
let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{
 appendFileSync(${JSON.stringify(log)},JSON.stringify({resumed:process.argv.includes("resume"),prompt})+"\\n");
 if(process.env.EARLY_WRITE==="1"&&!process.argv.includes("resume")){mkdirSync(${JSON.stringify(join(root,"output"))},{recursive:true});writeFileSync(${JSON.stringify(join(root,"output/revision.txt"))},"premature\\n");}
 const send=value=>console.log(JSON.stringify(value));
 send({type:"thread.started",thread_id:"11111111-1111-7111-8111-111111111111"});send({type:"turn.started"});
 send({type:"item.completed",item:{type:"command_execution",id:"observed-tool",command:"pwd",exit_code:0,aggregated_output:process.cwd()}});
 send({type:"turn.completed"});
});
`, { mode: 0o700 });
  const workload = createWorkload({ level: 1, seed: "retained-change-lifecycle", batch: 0 });
  const options = { executable: peer, cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "retained-conversation-change", signal: new AbortController().signal, timeoutMs: 2000,
    onRecord: async () => {}, checkpoint: () => {} };
  try {
    const result = await runNativeScenario(options);
    expect(result).toMatchObject({ status: "completed", threadId: "11111111-1111-7111-8111-111111111111", variant: "retained-conversation-change", toolItems: 2,
      preparation: { status: "completed" }, historyWitnessSha256: createHash("sha256").update(`${largeHistoryWitness(workload)}\n`).digest("hex"),
      revisionWitnessSha256: createHash("sha256").update(`${retainedConversationRevision(workload)}\n`).digest("hex") });
    const prompts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { resumed: boolean; prompt: string });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.resumed).toBe(false);
    expect(prompts[0]!.prompt).toContain(largeHistoryWitness(workload));
    expect(prompts[0]!.prompt).not.toContain(retainedConversationRevision(workload));
    expect(prompts[1]!.resumed).toBe(true);
    expect(prompts[1]!.prompt).not.toContain(largeHistoryWitness(workload));
    expect(prompts[1]!.prompt).toContain(retainedConversationRevision(workload));
    expect(prompts[1]!.prompt).toContain("generated local fixture checks for the requested artifacts");
    await expect(runNativeScenario({ ...options, route: CHATGPT_WEB_LUNA_MODEL_ROUTES[0]! })).rejects.toThrow("Sol retained-browser path");
    await expect(runNativeScenario({ ...options, env: { EARLY_WRITE: "1" } })).rejects.toThrow("before the changed instruction");
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
      exerciseMultipartTransport: true,
      beforeGeneration: async () => { generationReservations++; },
      onRecord: async () => {}, checkpoint: () => {} });
    expect(generationReservations).toBe(5);
    expect(result).toMatchObject({ status: "completed", threadId: "thread-one", scenario: { turns: [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }, { id: "turn-4" }], compaction: { turnId: "compact-1", itemId: "compaction-item-1", turn: { status: "completed" } } } });
    const prompts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { text: string });
    expect(prompts).toHaveLength(4);
    expect(prompts[0]!.text).toContain(largeHistoryWitness(workload));
    expect(prompts[0]!.text).toContain("Background note 1200:");
    expect(prompts[1]!.text).toContain("Background note 2400:");
    expect(prompts[1]!.text).not.toContain(largeHistoryWitness(workload));
    expect(prompts[2]!.text).toContain("Background note 3600:");
    expect(prompts[3]!.text).toContain("output/history-witness.txt");
    expect(prompts[3]!.text).not.toContain("Background note 3600:");
    expect(result).toMatchObject({ scenario: { multipartContext: { notes: 3600, records: 3 } } });
    await expect(runNativeScenario({ executable: peer, cwd: root, env: { FAIL_COMPACT: "1" }, route: CHATGPT_WEB_MODEL_ROUTES[0]!, workload, variant: "compaction", signal: new AbortController().signal, timeoutMs: 2000,
      onRecord: async () => {}, checkpoint: () => {} })).rejects.toMatchObject({ code: "native_scenario_failed", nativeFailure: { threadId: "thread-one", turns: [{ status: "completed" }, { id: "compact-1", status: "failed" }] } });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(5);
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
