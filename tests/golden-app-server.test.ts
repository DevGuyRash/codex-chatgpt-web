import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoldenAppServer } from "../scripts/golden/app-server";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "golden-app-server-")), peer = join(root, "peer.ts");
  writeFileSync(peer, `
const send = message => process.stdout.write(JSON.stringify(message)+"\\n");
let buffer="", n=0, compactMode="early";
process.stdin.on("data", chunk => { buffer+=chunk.toString(); for (;;) {
 const i=buffer.indexOf("\\n"); if(i<0)break; const m=JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
 if(m.method==="initialize")send({id:m.id,result:{userAgent:"fixture"}});
 if(m.method==="thread/start" || m.method==="thread/resume")send({id:m.id,result:{thread:{id:"thread-one"},model:m.params.model,modelProvider:"openai",reasoningEffort:"low",cwd:m.params.cwd}});
 if(m.method==="test/ancillary") {
  for(let i=0;i<140;i++)send({method:"turn/completed",params:{threadId:"thread-one",turn:{id:"background-"+i,status:"completed",items:[]}}});
  send({id:m.id,result:{observed:140}});
 }
 if(m.method==="test/compact-mode") { compactMode=m.params.mode; send({id:m.id,result:{}}); }
 if(m.method==="thread/compact/start") {
  const id="compact-"+(++n), item={id:"compact-item-"+n,type:"contextCompaction"};
  const complete=()=>{
   send({method:"turn/started",params:{threadId:"thread-one",turn:{id,status:"inProgress",items:[]}}});
   send({method:"item/started",params:{threadId:"thread-one",turnId:id,item}});
   if(compactMode!=="missing-item")send({method:"item/completed",params:{threadId:"thread-one",turnId:id,item}});
   send({method:"turn/completed",params:{threadId:"thread-one",turn:{id,status:"completed",items:[item]}}});
  };
  if(compactMode==="foreign")send({method:"turn/completed",params:{threadId:"other",turn:{id:"unowned",status:"completed",items:[]}}});
  if(compactMode==="early" || compactMode==="foreign" || compactMode==="missing-item")complete();
  send({id:m.id,result:{}});
  if(compactMode==="late")setTimeout(complete,5);
 }
 if(m.method==="turn/start") {
  const id="turn-"+(++n), text=m.params.input[0].text;
  send({method:"turn/started",params:{threadId:"thread-one",turn:{id,status:"inProgress",items:[]}}});
  if(text==="early-with-ancillary")for(let i=0;i<140;i++)send({method:"turn/completed",params:{threadId:"thread-one",turn:{id:"background-active-"+i,status:"completed",items:[]}}});
  if(text==="uncertain")continue;
  if(text==="early" || text==="early-with-ancillary")send({method:"turn/completed",params:{threadId:"thread-one",turn:{id,status:"completed",items:[]}}});
  if(text==="wrong-thread")send({method:"turn/completed",params:{threadId:"other",turn:{id,status:"completed",items:[]}}});
  send({id:m.id,result:{turn:{id,status:"inProgress",items:[]}}});
 }
 if(m.method==="turn/steer")send({id:m.id,result:{turnId:m.params.expectedTurnId}});
 if(m.method==="turn/interrupt") {
  send({id:m.id,result:{}});
  send({method:"turn/completed",params:{threadId:m.params.threadId,turn:{id:m.params.turnId,status:"interrupted",items:[]}}});
 }
} });
process.stdin.on("end",()=>process.exit(0));
`);
  const frames: { direction: string; message: Record<string, unknown> }[] = [];
  const app = new GoldenAppServer({ executable: process.execPath, args: [peer], cwd: root, env: {}, route: CHATGPT_WEB_MODEL_ROUTES[0]!, onFrame: frame => { frames.push(frame); } });
  return { app, root, frames, close: async () => { await app.close(100); rmSync(root, { recursive: true, force: true }); } };
}

test("ancillary same-thread completions cannot occupy an owned turn cache", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    expect(await f.app.rpc.request("test/ancillary", {})).toEqual({ observed: 140 });
    const turn = await f.app.startTurn({ text: "early-with-ancillary" });
    expect(await f.app.waitForCompletion(turn.id)).toMatchObject({ id: "turn-1", status: "completed" });
    expect(f.frames.filter(frame => frame.direction === "received" && frame.message.method === "turn/completed")).toHaveLength(281);
  } finally { await f.close(); }
});

test("native turn completion can precede its acknowledgement without being lost", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    const turn = await f.app.startTurn({ text: "early" });
    expect(await f.app.waitForCompletion(turn.id)).toMatchObject({ id: "turn-1", status: "completed" });
    const next = await f.app.startTurn({ text: "wrong-thread" });
    await expect(f.app.waitForCompletion(next.id, { timeoutMs: 20 })).rejects.toMatchObject({ code: "native_event_timeout" });
    await expect(f.app.startTurn({ text: "no replay" })).rejects.toMatchObject({ code: "native_turn_unsettled" });
    await f.app.interrupt(next.id);
    expect(await f.app.waitForCompletion(next.id)).toMatchObject({ status: "interrupted" });
  } finally { await f.close(); }
});

test("Plan revision, steering and subsequent execution retain the native turn preconditions", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    const plan = await f.app.startTurn({ text: "plan", mode: "plan" });
    await f.app.steer(plan.id, { text: "revise" });
    await expect(f.app.steer("stale", { text: "wrong target" })).rejects.toMatchObject({ code: "native_turn_mismatch" });
    await f.app.interrupt(plan.id); await f.app.waitForCompletion(plan.id);
    await f.app.startTurn({ text: "execute", mode: "default" });
    const starts = f.frames.filter(f => f.direction === "sent" && f.message.method === "turn/start");
    expect(starts.map(f => (f.message.params as any).collaborationMode.mode)).toEqual(["plan", "default"]);
    expect((f.frames.find(f => f.message.method === "turn/steer")!.message.params as any).expectedTurnId).toBe(plan.id);
  } finally { await f.close(); }
});

test("uncertain submission retains observed identity and forbids a second start", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    await expect(f.app.startTurn({ text: "uncertain", acknowledgementTimeoutMs: 20 })).rejects.toMatchObject({ uncertain: true });
    expect(f.app.state()).toMatchObject({ threadId: "thread-one", turnId: "turn-1", submission: "uncertain" });
    await expect(f.app.startTurn({ text: "duplicate" })).rejects.toMatchObject({ code: "native_turn_unsettled" });
    await f.app.interrupt("turn-1");
    expect(await f.app.waitForCompletion("turn-1")).toMatchObject({ status: "interrupted" });
    expect(f.app.state().submission).toBe("idle");
  } finally { await f.close(); }
});

test("a turn route override preserves native ownership and never permits Pro switching", async () => {
  const f = fixture();
  const alternate = CHATGPT_WEB_MODEL_ROUTES[1]!;
  const pro = CHATGPT_WEB_MODEL_ROUTES.find(route => route.adapterEffort === "max")!;
  try {
    await f.app.initialize(); await f.app.openThread();
    await expect(f.app.startTurn({ text: "forbidden", route: pro })).rejects.toThrow("non-Pro");
    expect(f.app.state().submission).toBe("idle");
    const first = await f.app.startTurn({ text: "early", route: alternate });
    await expect(f.app.startTurn({ text: "unsettled" })).rejects.toMatchObject({ code: "native_turn_unsettled" });
    await f.app.waitForCompletion(first.id);
    const second = await f.app.startTurn({ text: "early" }); await f.app.waitForCompletion(second.id);
    const starts = f.frames.filter(frame => frame.direction === "sent" && frame.message.method === "turn/start").map(frame => frame.message.params as any);
    expect(starts).toHaveLength(2);
    expect(starts.map(params => [params.threadId, params.model, params.effort, params.collaborationMode.settings.model, params.collaborationMode.settings.reasoning_effort])).toEqual([alternate, CHATGPT_WEB_MODEL_ROUTES[0]!].map(route => ["thread-one", route.slug, route.codexEffort, route.slug, route.codexEffort]));
  } finally { await f.close(); }
});

test("native compaction requires its exact item and terminal even when both precede acknowledgement", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    await f.app.rpc.request("test/compact-mode", { mode: "foreign" });
    const compact = await f.app.compact();
    expect(compact).toMatchObject({ threadId: "thread-one", turnId: "compact-1", itemId: "compact-item-1", turn: { id: "compact-1", status: "completed" } });
    expect(f.app.state().compaction).toBe("idle");
    const next = await f.app.startTurn({ text: "early" });
    expect(await f.app.waitForCompletion(next.id)).toMatchObject({ status: "completed" });
  } finally { await f.close(); }
});

test("native compaction accepts later terminal notifications but never an item-free acknowledgement", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    await f.app.rpc.request("test/compact-mode", { mode: "late" });
    expect(await f.app.compact()).toMatchObject({ turnId: "compact-1", turn: { status: "completed" } });
    await f.app.rpc.request("test/compact-mode", { mode: "missing-item" });
    await expect(f.app.compact({ timeoutMs: 20 })).rejects.toMatchObject({ code: "native_event_timeout", uncertain: true });
    await expect(f.app.startTurn({ text: "must not replay" })).rejects.toMatchObject({ code: "native_turn_unsettled" });
  } finally { await f.close(); }
});

test("native compaction cancellation and close release observation without admitting another turn", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    await f.app.rpc.request("test/compact-mode", { mode: "silent" });
    const abort = new AbortController();
    const compact = f.app.compact({ signal: abort.signal, timeoutMs: 5000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    abort.abort();
    await expect(compact).rejects.toMatchObject({ code: "native_observation_cancelled", uncertain: true });
    await expect(f.app.startTurn({ text: "must not replay" })).rejects.toMatchObject({ code: "native_turn_unsettled" });
  } finally { await f.close(); }
});

test("closing the native owner releases an in-flight compact waiter and its bounded cache", async () => {
  const f = fixture();
  try {
    await f.app.initialize(); await f.app.openThread();
    await f.app.rpc.request("test/compact-mode", { mode: "silent" });
    const compact = f.app.compact({ timeoutMs: 5000 });
    void compact.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    await f.app.close(100);
    await expect(compact).rejects.toMatchObject({ code: "native_process_closing" });
    expect(f.app.state().compaction).toBe("idle");
  } finally { await f.close(); }
});
