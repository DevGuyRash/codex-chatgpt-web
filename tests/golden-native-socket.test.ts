import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRpc } from "../scripts/golden/native-protocol";
import { inspectOwnedNativeSocket } from "../scripts/golden/native-socket";
import { ownedProcessIdentity, ownsProcess } from "../scripts/golden/workspace";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "golden-socket-")), path = join(root, "rpc.sock"), script = join(root, "peer.ts");
  chmodSync(root, 0o700);
  writeFileSync(script, `let count=0;Bun.serve({unix:process.argv[2],fetch(req,server){if(server.upgrade(req))return;return new Response(null,{status:400});},websocket:{message(ws,text){const m=JSON.parse(String(text));if(m.method==='effect')count++;if(m.method==='binary'){ws.send(new Uint8Array([1,2]));return;}if(m.method==='invalid'){ws.send('broken');return;}if(m.method==='large'){ws.send('x'.repeat(300));return;}if(m.method==='backlog'){for(let i=0;i<10;i++)ws.send(JSON.stringify({method:'held',params:{text:'x'.repeat(100)}}));return;}if(m.method==='disconnect'){ws.close();return;}ws.send(JSON.stringify({id:m.id,result:{count}}));}}});console.log('ready');`);
  const child = spawn(process.execPath, [script, path], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket fixture did not start")), 3000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Socket fixture exited before readiness")); });
    });
    const owner = ownedProcessIdentity(child.pid!)!;
    return { identity: { path, inode: lstatSync(path).ino, owner }, root, async close() { child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); throw error; }
}

test("private socket ownership failures are typed before attachment and after endpoint removal", async () => {
  const peer = await fixture(); let client: NativeRpc | undefined;
  try {
    for (const socket of [{ ...peer.identity, inode: 0 }, { ...peer.identity, path: join(peer.root, "absent") }, { ...peer.identity, owner: { ...peer.identity.owner, start: "stale" } }]) {
      expect(() => new NativeRpc({ socket, onFrame: () => {} })).toThrow(expect.objectContaining({ code: "native_tui_ownership_missing" }));
    }
    client = new NativeRpc({ socket: peer.identity, onFrame: () => {} });
    expect(await client.request("count")).toEqual({ count: 0 });
    unlinkSync(peer.identity.path);
    await expect(client.request("effect")).rejects.toMatchObject({ code: "native_tui_ownership_missing" });
    expect(ownsProcess(peer.identity.owner)).toBeTrue();
  } finally { await client?.close(100); await peer.close(); }
});

test("an owned private link may target only the native process's exact socket", async () => {
  const peer = await fixture(); let client: NativeRpc | undefined;
  const alias = join(peer.root, "native.sock");
  try {
    symlinkSync(peer.identity.path, alias);
    const linked = inspectOwnedNativeSocket(alias, peer.identity.owner);
    expect(linked.targetPath).toBe(peer.identity.path);
    expect(linked.linkInode).toBe(lstatSync(alias).ino);
    expect(inspectOwnedNativeSocket(alias, peer.identity.owner)).toEqual(linked);
    client = new NativeRpc({ socket: linked, onFrame: () => {} });
    expect(await client.request("count")).toEqual({ count: 0 });
    unlinkSync(alias);
    symlinkSync(peer.identity.path, alias);
    await expect(client.request("count")).rejects.toMatchObject({ code: "native_tui_ownership_missing" });
  } finally { await client?.close(100); await peer.close(); }
});

test("a private link to another native process cannot borrow its socket ownership", async () => {
  const first = await fixture(), second = await fixture();
  try {
    const alias = join(first.root, "foreign.sock");
    symlinkSync(second.identity.path, alias);
    expect(() => inspectOwnedNativeSocket(alias, first.identity.owner)).toThrow("not held by its recorded process");
  } finally { await second.close(); await first.close(); }
});

for (const [method, code] of [["binary", "native_protocol_invalid"], ["invalid", "native_protocol_invalid"], ["large", "native_protocol_too_large"], ["disconnect", "native_socket_closed"]]) test(`socket ${method} settles pending requests without killing its server`, async () => {
  const peer = await fixture(); const client = new NativeRpc({ socket: peer.identity, maxFrameBytes: 256, onFrame: () => {} });
  try {
    await expect(client.request(method!)).rejects.toMatchObject({ code });
    await expect(client.request("effect")).rejects.toMatchObject({ code });
    await client.close(100);
    expect(ownsProcess(peer.identity.owner)).toBeTrue();
  } finally { await client.close(100); await peer.close(); }
});

test("socket request capture cannot submit an effect after its deadline", async () => {
  const peer = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const client = new NativeRpc({ socket: peer.identity, onFrame: async frame => { if (frame.direction === "sent" && frame.message.method === "effect") await held; } });
  try {
    await expect(client.request("effect", {}, { timeoutMs: 25 })).rejects.toMatchObject({ code: "native_acknowledgement_timeout" });
    release();
    expect(await client.request("count")).toEqual({ count: 0 });
  } finally { release(); await client.close(100); await peer.close(); }
});

test("socket capture backlog is bounded and pending work fails while capture is held", async () => {
  const peer = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const client = new NativeRpc({ socket: peer.identity, maxFrameBytes: 256, onFrame: async frame => { if (frame.direction === "received") await held; } });
  try {
    await expect(client.request("backlog", {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: "native_protocol_too_large" });
    release(); await client.close(100);
    expect(ownsProcess(peer.identity.owner)).toBeTrue();
  } finally { release(); await client.close(100); await peer.close(); }
});

test("socket close reports capture that cannot drain within its cleanup bound", async () => {
  const peer = await fixture(); let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), capturing = new Promise<void>(resolve => { entered = resolve; });
  const client = new NativeRpc({ socket: peer.identity, onFrame: async frame => { if (frame.direction === "received") { entered(); await held; } } });
  const result = client.request("count").catch(error => error);
  try {
    await capturing;
    await expect(client.close(100)).rejects.toMatchObject({ code: "native_cleanup_incomplete" });
    expect(await result).toMatchObject({ code: "native_socket_closed" });
    expect(ownsProcess(peer.identity.owner)).toBeTrue();
  } finally { release(); await client.close(100).catch(() => {}); await peer.close(); }
}, 5000);
