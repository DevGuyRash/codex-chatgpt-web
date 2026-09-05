const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexRestartController } = require("../electron/codex-restart.cjs");

function fixture(overrides = {}) {
  let now = 0, running = true;
  const events = [];
  const app = { identity: "pid-and-start-time", label: "Codex", location: "/verified/Codex", pid: 123, launchEntry: "/verified/Codex", closeSupported: true };
  const adapter = { discover: async () => running ? [app] : [], sameInstance: async () => running, close: async () => { events.push("close"); running = false; }, launch: async () => { events.push("launch"); }, ...overrides };
  const controller = new CodexRestartController({ adapter, withIdleBridge: async operation => { events.push("guard"); return operation(); }, now: () => now, delay: async ms => { now += ms; } });
  return { controller, events, app };
}
test("availability does not close anything and execution requires its exact opaque identity", async () => {
  const { controller, events } = fixture();
  const availability = await controller.availability();
  assert.equal(availability.status, "available");
  assert.deepEqual(events, []);
  assert.equal((await controller.execute("arbitrary-pid")).reason, "stale");
  assert.deepEqual(events, []);
  assert.equal((await controller.execute(availability.token)).status, "launched");
  assert.deepEqual(events, ["guard", "close", "launch"]);
});
test("a timeout never launches or force kills the application", async () => {
  const { controller, events } = fixture({ close: async () => {}, sameInstance: async () => true });
  const availability = await controller.availability();
  assert.equal((await controller.execute(availability.token)).reason, "timeout");
  assert.deepEqual(events, ["guard"]);
});
test("ambiguous, unsupported, and changed identities fail closed", async () => {
  for (const candidates of [[], [{ identity: "a", closeSupported: false }], [{ identity: "a" }, { identity: "b" }]]) {
    const { controller, events } = fixture({ discover: async () => candidates });
    assert.equal((await controller.availability()).status, "manual");
    assert.deepEqual(events, []);
  }
  const { controller, events } = fixture({ sameInstance: async () => false });
  const availability = await controller.availability();
  assert.equal((await controller.execute(availability.token)).reason, "stale");
  assert.deepEqual(events, ["guard"]);
});
test("active bridge work and permission failures never cause a launch", async () => {
  const base = fixture();
  base.controller.withIdleBridge = async () => { throw new Error("Active bridge work"); };
  const availability = await base.controller.availability();
  assert.equal((await base.controller.execute(availability.token)).status, "manual");
  assert.deepEqual(base.events, []);
  const denied = fixture({ close: async () => { throw new Error("Permission denied"); } });
  assert.equal((await denied.controller.execute((await denied.controller.availability()).token)).status, "manual");
  assert.deepEqual(denied.events, ["guard"]);
});

test("restart evidence is separate from availability and can observe a manual replacement", async () => {
  const { controller, app } = fixture();
  await controller.availability();
  assert.equal(await controller.restartEvidence(), null);
  controller.adapter.discover = async () => [{ ...app, identity: "new-instance" }];
  assert.deepEqual(await controller.restartEvidence(), { after: 0 });
  controller.resetEvidence();
  assert.equal(await controller.restartEvidence(), null);
});

test("the runtime guard owns an idle drain through failure and rejects concurrent lifecycle work", async () => {
  const { RuntimeHost } = require("../electron/runtime.cjs");
  const events = [];
  const host = Object.create(RuntimeHost.prototype);
  Object.assign(host, { launcherProfile: "production", lifecycleOperation: null, active: null, activeChild: null, supervisor: {
    readConfig: () => ({ fixture: true }), daemon: { exitCode: null, signalCode: null },
    acquireDrain: async (_config, timeout) => { assert.equal(timeout, 0); events.push("drained"); return true; },
    control: async (_config, action) => events.push(action),
  } });
  await assert.rejects(host.withCodexRestartGuard(async () => {
    await assert.rejects(host.withCodexRestartGuard(async () => {}), /active launcher operation/);
    events.push("close-failed"); throw new Error("close failed");
  }), /close failed/);
  assert.deepEqual(events, ["drained", "close-failed", "resume"]);
  assert.equal(host.currentOperation(), null);
});

test("catalog receipt clears the reminder only with subsequent restart evidence", async () => {
  const source = require("node:fs").readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const start = source.indexOf("function startCatalogVerificationMonitor(");
  const end = source.indexOf("async function restoreCodexRouteAfterRuntimeFailure(", start);
  for (const [evidence, clear] of [[null, false], [{ after: 2000 }, false], [{ after: 500 }, true]]) {
    const updates = [];
    require("node:vm").runInNewContext(`${source.slice(start, end)}\nstartCatalogVerificationMonitor({ logger, stateStore });`, {
      stopCatalogVerificationMonitor() {}, catalogVerificationInFlight: false,
      runtimeSupervisor: { readConfig: () => ({}), proxyHealthPayload: async () => ({ successful_model_catalog_requests: 1, last_successful_model_catalog_request_at: new Date(1000).toISOString() }) },
      codexRestartController: { restartEvidence: async () => evidence },
      stateStore: { read: () => ({ coreSetupComplete: true, codexCatalogVerified: false, codexRestartRequired: true }), update: value => { updates.push(value); return value; } },
      logger: { info() {}, debug() {} }, send() {}, setInterval: () => ({ unref() {} }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updates.length, 1);
    assert.equal(updates[0].codexRestartRequired, !clear);
  }
});
