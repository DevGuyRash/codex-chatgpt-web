import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeRpc, NativeRpcError } from "../scripts/golden/native-protocol";
import { ActiveProgress } from "../scripts/golden/progress";
import { problemFor } from "../src/diagnostics/problems";

for (const termination of ["exit", "signal"] as const) test(`native protocol failure preserves observed ${termination} without copying stderr into its problem`, async () => {
  const stop = termination === "exit" ? "process.exit(7)" : "process.kill(process.pid, 'SIGTERM')";
  let stderr = "";
  const client = new NativeRpc({ executable: process.execPath,
    args: ["-e", `process.stdin.once('data',()=>process.stderr.write('private native detail',()=>{${stop}}))`],
    cwd: tmpdir(), env: {}, onFrame: () => {}, onStderr: text => { stderr += text; },
  });
  try {
    let failure: unknown;
    try { await client.request("initialize"); } catch (error) { failure = error; }
    const problem = problemFor(failure);
    expect(problem).toMatchObject({ code: "native_process_exited", ...(termination === "exit" ? { exitCode: 7, signal: null } : { signal: "SIGTERM" }) });
    expect(stderr).toBe("private native detail");
    expect(JSON.stringify(problem)).not.toContain("private native detail");
  } finally { await client.close(100); }
});

test("native failures retain their code and uncertain outcome in diagnostic exports", () => {
  const error = new NativeRpcError("Native initialize acknowledgement timed out; submission may have occurred", "native_acknowledgement_timeout", true);
  expect(problemFor(error)).toMatchObject({ code: "native_acknowledgement_timeout", origin: "golden-native", retryable: false, recovery: "unknown" });
  expect(problemFor(error).evidenceMissing).toBeUndefined();
});

test("native RPC handles fragmented frames and bidirectional IDs and rejects uncertain acknowledgements", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-rpc-"));
  const script = join(root, "peer.ts");
  writeFileSync(script, `
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\\n");
let text = "";
process.stdin.on("data", chunk => { text += chunk.toString(); for (;;) { const i = text.indexOf("\\n"); if (i < 0) break; const m = JSON.parse(text.slice(0,i)); text = text.slice(i+1);
  if (m.method === "echo") { write({id:m.id,method:"approval",params:{}}); const line = JSON.stringify({id:m.id,result:{echo:m.params.text}})+"\\n"; process.stdout.write(line.slice(0,5)); setTimeout(()=>process.stdout.write(line.slice(5)),5); }
  else if (m.method === "notify") { write({method:"turn/completed",params:{turnId:"one"}}); write({id:m.id,result:{}}); }
  else if (m.method === "failure") write({id:m.id,error:{code:123,message:"synthetic failure"}});
} });
`);
  const frames: unknown[] = [];
  const client = new NativeRpc({ executable: process.execPath, args: [script], cwd: root, env: { PATH: process.env.PATH }, onFrame: frame => { frames.push(frame); }, onServerRequest: async () => ({ decision: "decline" }) });
  try {
    expect(await client.request("echo", { text: "東京" })).toEqual({ echo: "東京" });
    const completed = client.waitFor("turn/completed", params => params.turnId === "one");
    await client.request("notify");
    expect(await completed).toEqual({ turnId: "one" });
    await expect(client.request("failure")).rejects.toMatchObject({ code: "native_rpc_rejected", rpcCode: 123 });
    await expect(client.request("never-acknowledged", {}, { timeoutMs: 25 })).rejects.toMatchObject({ code: "native_acknowledgement_timeout", uncertain: true });
    expect(frames.length).toBeGreaterThan(4);
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
});

test("buffered native frames share receipt time despite slow evidence capture", async () => {
  const script = `process.stdin.once('data', bytes => { const request = JSON.parse(bytes.toString()); process.stdout.write(
    JSON.stringify({method:'item/agentMessage/delta',params:{delta:'one'}})+'\\n'+
    JSON.stringify({method:'item/agentMessage/delta',params:{delta:'two'}})+'\\n'+
    JSON.stringify({id:request.id,result:{ok:true}})+'\\n'); });`;
  const clock = new ActiveProgress();
  const times: number[] = [];
  const client = new NativeRpc({ executable: process.execPath, args: ["-e", script], cwd: tmpdir(), env: {},
    onFrame: async frame => {
      if (frame.direction !== "received" || frame.message.method !== "item/agentMessage/delta") return;
      times.push(frame.receivedAtMs!);
      await Bun.sleep(30);
      clock.observe(frame.receivedAtMs!, "generation", {
        traceId: "a".repeat(32), kind: "attachment", id: `00000000-0000-4000-8000-${String(times.length).padStart(12, "0")}`,
        sha256: "b".repeat(64),
      });
    },
  });
  try {
    expect(await client.request("start")).toEqual({ ok: true });
    expect(times).toHaveLength(2);
    expect(times[1]).toBe(times[0]);
    expect(clock.finishBatch(times[1]! + 100, true).creditedMs).toBe(0);
  } finally { await client.close(100); }
});

test("a broken native transport settles waiters and cannot accept more commands", async () => {
  const client = new NativeRpc({ executable: process.execPath, args: ["-e", 'process.stdout.write("not-json\\n"); setTimeout(()=>{},10000)'], cwd: tmpdir(), env: {}, onFrame: () => {} });
  try {
    await expect(client.waitFor("turn/completed", () => true)).rejects.toMatchObject({ code: "native_protocol_invalid" });
    await expect(client.request("turn/start")).rejects.toMatchObject({ code: "native_protocol_invalid" });
  } finally { await client.close(); }
});

test("a request whose capture outlives its deadline cannot be submitted afterward", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-rpc-expired-")), script = join(root, "peer.ts");
  writeFileSync(script, `let count=0, buffer="";process.stdin.on("data",chunk=>{buffer+=chunk.toString();for(;;){const i=buffer.indexOf("\\n");if(i<0)break;const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(m.method==="effect")count++;process.stdout.write(JSON.stringify({id:m.id,result:{count}})+"\\n");}});process.stdin.on("end",()=>process.exit(0));`);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const client = new NativeRpc({ executable: process.execPath, args: [script], cwd: root, env: {}, onFrame: async frame => { if (frame.direction === "sent" && frame.message.method === "effect") await held; } });
  try {
    await expect(client.request("effect", {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: "native_acknowledgement_timeout" });
    release();
    expect(await client.request("count")).toEqual({ count: 0 });
  } finally { release(); await client.close(100); rmSync(root, { recursive: true, force: true }); }
}, 1000);

test("closing a native parent also settles a tool child that inherited its pipes", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-rpc-child-"));
  const script = join(root, "parent.ts");
  writeFileSync(script, `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"inherit"});
process.stdin.on("data", bytes => { const message=JSON.parse(bytes.toString()); process.stdout.write(JSON.stringify({id:message.id,result:{ready:true}})+"\\n"); });
process.stdin.on("end",()=>process.exit(0));
`);
  const client = new NativeRpc({ executable: process.execPath, args: [script], cwd: root, env: {}, onFrame: () => {} });
  try {
    expect(await client.request("ready")).toEqual({ ready: true });
    await client.close(100);
  } finally { await client.close(100); rmSync(root, { recursive: true, force: true }); }
}, 5000);

test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY)("the installed native app-server initializes through the golden RPC driver without generation", async () => {
  const root = mkdtempSync(join(tmpdir(), "golden-native-initialize-"));
  mkdirSync(join(root, "codex"));
  let stderr = "";
  const client = new NativeRpc({ executable: process.env.CODEX_TEST_PROFILE_BINARY!, args: ["app-server", "--listen", "stdio://"], cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "codex") }, onFrame: () => {}, onStderr: text => { stderr = (stderr + text).slice(-8192); } });
  try {
    const response = await client.request("initialize", { clientInfo: { name: "golden-offline-probe", version: "1" }, capabilities: { experimentalApi: true } }).catch(error => { throw new Error(`${error.message}: ${stderr}`); });
    expect(response).toMatchObject({ userAgent: expect.any(String) });
    await client.notify("initialized");
  } finally { await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
