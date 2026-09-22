import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import { join } from "node:path";
import { rememberResponseState, expandPreviousResponseInput, flushResponseState } from "../../src/responses/state";
import { initializeRuntimeDiagnostics, closeRuntimeDiagnostics } from "../../src/diagnostics/runtime";
import type { DiagnosticEvent } from "../../src/diagnostics/contracts";

const home = process.env.CODEX_CHATGPT_WEB_HOME!;
const path = join(home, "responses-state.json");
const remember = (id: string) => rememberResponseState({ input: id }, { id, output: [] });
const ids = () => (JSON.parse(fs.readFileSync(path, "utf8")) as { states: [string, unknown][] }).states.map(([id]) => id);
const rename = asyncFs.rename;
const scenario = process.argv[2];

if (scenario === "slow") {
  const order: string[] = [];
  // Both implementations encounter the same slow replacement. Only an asynchronous
  // writer allows unrelated timers to run before flush settles.
  const renameSync = fs.renameSync;
  spyOn(fs, "renameSync").mockImplementation((...args) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    renameSync(...args);
  });
  spyOn(asyncFs, "rename").mockImplementation(async (...args) => {
    await Bun.sleep(150);
    return rename(...args);
  });
  remember("first");
  const pulse = new Promise<void>(resolve => setTimeout(() => { order.push("pulse"); resolve(); }, 10));
  await flushResponseState();
  order.push("flushed");
  await pulse;
  assert.deepEqual(order, ["pulse", "flushed"]);
  assert.deepEqual(ids(), ["first"]);
} else if (scenario === "coalesce") {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let writes = 0, active = 0, maxActive = 0;
  spyOn(asyncFs, "rename").mockImplementation(async (...args) => {
    writes++; active++; maxActive = Math.max(maxActive, active);
    try {
      if (writes === 1) { entered(); await blocked; }
      return await rename(...args);
    } finally { active--; }
  });
  remember("first");
  let firstSettled = false, secondSettled = false;
  const first = flushResponseState().then(() => { firstSettled = true; });
  await started;
  for (let index = 0; index < 30; index++) remember(`later-${index}`);
  const second = flushResponseState().then(() => { secondSettled = true; });
  await Bun.sleep(20);
  assert.equal(firstSettled, false);
  assert.equal(secondSettled, false);
  assert.equal(writes, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(writes, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(ids(), ["first", ...Array.from({ length: 30 }, (_, index) => `later-${index}`)]);
} else if (scenario === "failure") {
  const events: DiagnosticEvent[] = [];
  initializeRuntimeDiagnostics({ component: "runtime", sink: { emit: event => { events.push(event); } } });
  remember("first");
  await flushResponseState();
  const before = fs.readFileSync(path);
  const mock = spyOn(asyncFs, "rename").mockRejectedValue(new Error("private filesystem detail"));
  remember("second");
  await flushResponseState();
  assert.deepEqual(fs.readFileSync(path), before);
  assert.deepEqual(fs.readdirSync(home), ["responses-state.json"]);
  assert.deepEqual(expandPreviousResponseInput({ previous_response_id: "second", input: "next" }), {
    previous_response_id: "second", input: [{ role: "user", content: "second" }, { role: "user", content: "next" }],
  });
  assert.ok(JSON.stringify(events).includes("response_state_persistence_failed"));
  assert.ok(!JSON.stringify(events).includes("private filesystem detail"));
  mock.mockRestore();
  remember("third");
  await flushResponseState();
  assert.deepEqual(ids(), ["first", "second", "third"]);
  await closeRuntimeDiagnostics();
} else if (scenario === "shutdown") {
  const { startServer } = await import("../../src/server");
  const { defaultConfig } = await import("../../src/config");
  let closed = false;
  initializeRuntimeDiagnostics({ component: "runtime", sink: {
    emit() {},
    async flush() { assert.deepEqual(ids(), ["first"]); closed = true; },
  } });
  spyOn(asyncFs, "rename").mockImplementation(async (...args) => { await Bun.sleep(100); return rename(...args); });
  const server = startServer({ ...defaultConfig("browser-only"), port: 0 });
  remember("first");
  process.emit("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (!closed && Date.now() < deadline) await Bun.sleep(10);
  await server.stop(true);
  assert.equal(closed, true, "server shutdown must persist before closing diagnostics");
} else if (scenario === "owner") {
  remember("first");
  process.env.CODEX_CHATGPT_WEB_HOME = join(home, "other-home");
  await flushResponseState();
  assert.deepEqual(ids(), ["first"]);
  assert.equal(fs.existsSync(join(home, "other-home")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  }
} else throw new Error(`Unknown scenario: ${scenario}`);
