const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexRestartController } = require("../electron/codex-restart.cjs");
const { catalogConfigurationKey } = require("../electron/generated/configuration-summary.cjs");

test("catalog-only runtime changes invalidate an earlier restart while approval preferences do not", async () => {
  const config = { mode: "full", subagentProtocol: "native", browserInteractionMode: "automatic", solAvailable: true, proAvailable: false, experimentalBiggerContext: false };
  let identity = "instance-one", saved;
  const controller = new CodexRestartController({ adapter: { discover: async () => [{ identity, location: "/verified/Codex" }] }, withIdleBridge: operation => operation(), readRevision: () => catalogConfigurationKey(config), saveEvidence: evidence => saved = evidence });
  await controller.reconcileConfiguration();
  identity = "instance-two";
  assert.ok(await controller.restartEvidence());
  config.autoApproveToolCalls = true;
  assert.ok(await controller.restartEvidence());
  config.experimentalBiggerContext = true;
  assert.equal(await controller.restartEvidence(), null);
  assert.equal(saved.baseline.identity, "instance-two");
  identity = "instance-three";
  assert.ok(await controller.restartEvidence());
  config.zeroRiskProEnabled = true;
  assert.equal(await controller.restartEvidence(), null);
});

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
test("a closed installed application can launch, but a newly started instance invalidates the request", async () => {
  const installed = { executable: "/verified/Codex", location: "/verified/Codex", source: "verified-entry", label: "Codex" };
  const { controller, events } = fixture({ discover: async () => [], installed: async () => [installed] });
  const available = await controller.availability();
  assert.equal(available.mode, "launch");
  assert.equal((await controller.execute(available.token)).status, "launched");
  assert.deepEqual(events, ["guard", "launch"]);
  const second = await controller.availability();
  controller.adapter.discover = async () => [{ ...installed, identity: "new-instance" }];
  assert.equal((await controller.execute(second.token)).reason, "stale");
  assert.deepEqual(events, ["guard", "launch", "guard"]);
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
test("configuration changes establish a durable baseline without opening the restart dialog", async () => {
  let revision = "target-a:config-one", identity = "instance-one", saved;
  const adapter = { discover: async () => [{ identity, location: "/verified/Codex" }] };
  const options = { adapter, withIdleBridge: operation => operation(), now: () => 1000, readRevision: () => revision, saveEvidence: value => { saved = structuredClone(value); } };
  const controller = new CodexRestartController(options);
  await controller.reconcileConfiguration();
  assert.equal(saved.revision, revision);
  identity = "instance-two";
  const reopened = new CodexRestartController({ ...options, savedEvidence: saved });
  assert.deepEqual(await reopened.restartEvidence(), { after: 1000 });
  revision = "target-a:config-two";
  assert.equal(await reopened.restartEvidence(), null);
  assert.equal(saved.baseline.identity, identity);
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

test("a failed baseline discovery remains retryable and never persists the new revision", async () => {
  let fail = true;
  const saved = [];
  const controller = new CodexRestartController({
    adapter: { discover: async () => { if (fail) throw new Error("discovery unavailable"); return [{ identity: "current", location: "/Codex" }]; } },
    withIdleBridge: operation => operation(), readRevision: () => "changed", saveEvidence: value => saved.push(value),
  });
  await assert.rejects(controller.reconcileConfiguration(), /discovery unavailable/);
  assert.equal(saved.length, 0);
  fail = false;
  await controller.reconcileConfiguration();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].baseline.identity, "current");
});

test("concurrent baseline requests discard discovery from an obsolete configuration", async () => {
  let revision = "first", release;
  let calls = 0;
  const saved = [];
  const controller = new CodexRestartController({
    adapter: { discover: async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return [{ identity: `instance-${calls}`, location: "/Codex" }]; } },
    withIdleBridge: operation => operation(), readRevision: () => revision, saveEvidence: value => saved.push(value),
  });
  const first = controller.reconcileConfiguration();
  await new Promise(resolve => setImmediate(resolve));
  revision = "second";
  const second = controller.reconcileConfiguration();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].revision, "second");
  assert.equal(saved[0].baseline.identity, "instance-2");
});
