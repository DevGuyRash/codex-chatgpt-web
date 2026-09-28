const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("idle shutdown authenticates, refuses busy work, and acknowledges before closing", async () => {
  let busy = true;
  let calls = 0;
  let acknowledged = false;
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => null,
    getPreferences: () => ({}),
    shutdownIdle: async acknowledge => {
      calls += 1;
      if (busy) return { ok: false, code: "launcher_busy" };
      await acknowledge();
      acknowledged = true;
      await server.close();
      return { ok: true };
    },
  }).start();
  const { endpoint, token } = server.descriptor();
  const request = authorization => fetch(`${endpoint}/v1/launcher/shutdown-idle`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: "{}",
  });
  try {
    assert.equal((await request("Bearer wrong")).status, 401);
    assert.equal(calls, 0);
    const blocked = await request(`Bearer ${token}`);
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: "launcher_busy" });
    assert.equal(acknowledged, false);
    busy = false;
    const response = await request(`Bearer ${token}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(acknowledged, true);
    assert.equal(calls, 2);
  } finally { await server.close(); }
});

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return {
        surfaceId: "launcher_surface_id_0123456789AB",
        tabId: "tab-1",
        reused: false,
        connectorBound: false,
      };
    },
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    setTurnApprovalPending: (...args) => { calls.push(["approval", ...args]); return { tabId: "tab-1" }; },
    endTurn: (...args) => {
      calls.push(["end", ...args]);
      return { cancelledByUser: false };
    },
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "abcdef123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        connectorIdentity: "Codex Native2",
        requireRetainedConversation: true,
      }),
    });
    assert.equal(start.status, 200);

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        refreshViewport: true,
      }),
    });
    assert.equal(heartbeat.status, 200);

    const invalidRefresh = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        refreshViewport: "yes",
      }),
    });
    assert.equal(invalidRefresh.status, 400);

    for (const [phase, pending] of [["approval", true], ["approval-settled", false]]) {
      const approval = await fetch(`${descriptor.endpoint}/v1/turn/${phase}`, {
        method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
        body: JSON.stringify({ phase, traceId: "abcdef123456", helperPid: process.pid }),
      });
      assert.equal(approval.status, 200);
      assert.deepEqual(await approval.json(), { ok: true, tabId: "tab-1" });
      assert.equal(calls.at(-1)[2], process.pid);
      assert.equal(calls.at(-1)[3], pending);
    }

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
        retain: true,
        connectorBound: true,
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(calls, [
      [
        "start",
        "abcdef123456",
        true,
        process.pid,
        "a".repeat(64),
        "Codex Native2",
        true,
      ],
      ["heartbeat", "abcdef123456", process.pid, true],
      ["approval", "abcdef123456", process.pid, true],
      ["approval", "abcdef123456", process.pid, false],
      ["end", "abcdef123456", process.pid, "completed", true, undefined, true, true],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("launcher tab lifecycle logs inherit the exact authenticated browser-turn context", async () => {
  const observed = [];
  let currentContext, interactionMode = "automatic";
  const logger = {
    info(name) { if (name.startsWith("browser.tab_")) observed.push({ name, context: currentContext }); },
    warn() {},
    diagnostics: {
      async withContext(context, action) {
        const previous = currentContext;
        currentContext = context;
        try { return await action(); }
        finally { currentContext = previous; }
      },
      event() {},
    },
  };
  const host = {
    browserInteractionMode: () => interactionMode,
    turnTabs: new Map(),
    beginTurn: async () => { logger.info("browser.tab_created"); return { surfaceId: "owned-surface", reused: false, connectorBound: false }; },
    endTurn: async () => { logger.info("browser.tab_retained"); return { cancelledByUser: false }; },
    beginManualTurn: () => { logger.info("browser.tab_reused"); return { surfaceId: "manual-surface", reused: true }; },
    endManualTurn: () => { logger.info("browser.tab_released"); return { cancelledByUser: false }; },
  };
  const server = await new BrowserControlServer({ logger, getBrowserHost: () => host, getPreferences: () => ({}) }).start();
  const { endpoint, token } = server.descriptor();
  const post = (path, traceId, extra = {}) => fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    body: JSON.stringify({ traceId, helperPid: process.pid, ...extra }),
  });
  try {
    assert.equal((await post("/v1/turn/start", "automatic-one")).status, 200);
    assert.equal((await post("/v1/turn/end", "automatic-one", { status: "completed", retain: true })).status, 200);
    interactionMode = "manual";
    assert.equal((await post("/v1/manual/start", "manual-one", { prompt: "Synthetic manual turn" })).status, 200);
    assert.equal((await post("/v1/manual/end", "manual-one", { status: "completed" })).status, 200);
    assert.deepEqual(observed.map(({ name, context }) => [name, context?.traceId, context?.taskId]), [
      ["browser.tab_created", "11111111111111111111111111111111", "automatic-one"],
      ["browser.tab_retained", "11111111111111111111111111111111", "automatic-one"],
      ["browser.tab_reused", "11111111111111111111111111111111", "manual-one"],
      ["browser.tab_released", "11111111111111111111111111111111", "manual-one"],
    ]);
  } finally { await server.close(); }
});

test("browser control server withholds a new turn lease until its browser surface is ready", async () => {
  let releaseSurface;
  let reportBegin;
  const surfaceReady = new Promise((resolve) => { releaseSurface = resolve; });
  const beginCalled = new Promise((resolve) => { reportBegin = resolve; });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "automatic",
      beginTurn() {
        reportBegin();
        return surfaceReady;
      },
    }),
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    let responseSettled = false;
    const responsePromise = fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "surface123456",
        helperPid: process.pid,
      }),
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    await beginCalled;
    await Promise.resolve();
    assert.equal(responseSettled, false);

    releaseSurface({
      surfaceId: "launcher_surface_id_0123456789AB",
      tabId: "tab-ready",
      reused: false,
      connectorBound: false,
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tabId, "tab-ready");
  } finally {
    await server.close();
  }
});

test("manual control keeps start idempotency separate from long Sent observation", async () => {
  const calls = [];
  const prompt = "p".repeat(32 * 1024);
  const host = {
    browserInteractionMode: () => "manual",
    beginManualTurn: (...args) => {
      calls.push(["start", ...args]);
      return {
        tabId: "manual-tab",
        reused: false,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        state: "awaiting-user",
      };
    },
    waitManualSent: async (...args) => {
      calls.push(["wait", ...args]);
      return { status: "sent", sentAt: "2026-08-30T00:00:00.000Z" };
    },
    waitManualTerminal: async (...args) => {
      calls.push(["wait-terminal", ...args]);
      return { status: "cancelled" };
    },
    markManualTurnStarted: (...args) => calls.push(["started", ...args]),
    endManualTurn: (...args) => {
      calls.push(["end", ...args]);
      return { cancelledByUser: false };
    },
  };
  const logs = [];
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push([event, detail]),
      warn() {},
      error() {},
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const post = (path, body) => fetch(`${descriptor.endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: "manual123456", helperPid: process.pid };
  try {
    assert.equal((await post("/v1/manual/start", {
      ...owner,
      prompt,
      resumePrompt: "incremental prompt",
      conversationKey: "c".repeat(64),
      compaction: true,
    })).status, 200);
    assert.equal((await post("/v1/manual/wait-sent", owner)).status, 200);
    assert.equal((await post("/v1/manual/wait-terminal", owner)).status, 200);
    assert.equal((await post("/v1/manual/started", owner)).status, 200);
    assert.equal((await post("/v1/manual/end", { ...owner, status: "completed", retain: true })).status, 200);
    assert.equal(calls[0][0], "start");
    assert.equal(calls[0][3], prompt);
    assert.equal(calls[0][5], "incremental prompt");
    assert.equal(calls[0][6], true);
    assert.equal(calls[1][0], "wait");
    assert.equal(calls[2][0], "wait-terminal");
    assert.equal(logs.some(([, detail]) => JSON.stringify(detail).includes(prompt)), false);
  } finally {
    await server.close();
  }
});

test("manual start has one explicit bounded body allowance and automatic turns stay disabled", async () => {
  let started = 0;
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "manual",
      beginManualTurn() {
        started += 1;
        return { tabId: "manual-tab", reused: false, deadlineAt: null, state: "awaiting-user" };
      },
      beginTurn() { throw new Error("must not start automatic turn"); },
    }),
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
  try {
    const tooLarge = await fetch(`${descriptor.endpoint}/v1/manual/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ traceId: "manual123456", helperPid: process.pid, prompt: "x".repeat((3 * 1024 * 1024) + 1) }),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal(started, 0);
    const automatic = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ traceId: "automatic123", helperPid: process.pid }),
    });
    assert.equal(automatic.status, 400);
  } finally {
    await server.close();
  }
});

test("manual control rejects session inspection before any browser helper can run", async () => {
  let inspected = false;
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "manual",
      inspectSession() {
        inspected = true;
        const error = new Error("ChatGPT session and capability inspection is disabled in Zero Risk mode");
        error.code = "manual_browser_inspection_disabled";
        throw error;
      },
    }),
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ detectCapabilities: true }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "ChatGPT session and capability inspection is disabled in Zero Risk mode",
      code: "manual_browser_inspection_disabled",
    });
    assert.equal(inspected, false);
  } finally {
    await server.close();
  }
});

test("session inspection exposes only the typed sign-in requirement", async () => {
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({ browserInteractionMode: () => "automatic", inspectSession() {
      const error = new Error("ChatGPT sign-in is required in the launcher before session inspection");
      error.code = "chatgpt_authentication_required";
      throw error;
    } }),
    getPreferences: () => ({ browserInteractionMode: "automatic" }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/session/inspect`, {
      method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ detectCapabilities: true }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "ChatGPT sign-in is required in the launcher before session inspection",
      code: "chatgpt_authentication_required",
    });
  } finally { await server.close(); }
});

test("manual-to-automatic transaction exposes capability inspection and preserves tabs on rollback", async () => {
  const retained = { id: "manual-ready", status: "ready", interactionMode: "manual" };
  const removed = [];
  let inspections = 0;
  let ownershipMarks = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    selectedTabId: retained.id,
    runSessionInspection: async (detectCapabilities) => {
      inspections += 1;
      assert.equal(detectCapabilities, true);
      assert.equal(host.browserInteractionMode(), "automatic");
      return { authenticated: true, temporary: true, url: "https://chatgpt.com/" };
    },
    removeTurnTab(tab, abortRunning) {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
    markOwnedSurface: async () => { ownershipMarks += 1; },
    snapshot: () => ({ activeTabId: "home" }),
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const inspect = () => fetch(`${descriptor.endpoint}/v1/session/inspect`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ detectCapabilities: true }),
  });
  try {
    await assert.rejects(
      host.withInteractionModeChange("automatic", async () => {
        const response = await inspect();
        assert.equal(response.status, 200);
        assert.equal(host.turnTabs.size, 1);
        throw new Error("runtime setup failed");
      }),
      /runtime setup failed/,
    );
    assert.equal(host.browserInteractionMode(), "manual");
    assert.deepEqual([...host.turnTabs.keys()], [retained.id]);
    assert.deepEqual(removed, []);

    const result = await host.withInteractionModeChange("automatic", async commit => {
      const response = await inspect();
      assert.equal(response.status, 200);
      await commit();
      return "configured";
    });
    assert.equal(result, "configured");
    assert.equal(host.browserInteractionMode(), "manual");
    assert.equal(host.turnTabs.size, 1);
    assert.deepEqual(removed, []);
    assert.equal(inspections, 2);
    assert.equal(ownershipMarks, 1);
  } finally {
    await server.close();
  }
});

test("browser control server reports a missing retained conversation as a typed conflict", async () => {
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: () => {
      const error = new Error("The retained ChatGPT conversation is no longer available");
      error.code = "retained_conversation_unavailable";
      throw error;
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "missing123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        requireRetainedConversation: true,
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "The retained ChatGPT conversation is no longer available",
      code: "retained_conversation_unavailable",
    });
  } finally {
    await server.close();
  }
});

test("browser control server releases only ready tabs for an authenticated conversation key", async () => {
  const removed = [];
  const releaseEvents = [];
  const ready = {
    id: "ready-tab",
    traceId: "ready-trace",
    status: "ready",
    conversationKey: "b".repeat(64),
  };
  const running = {
    id: "running-tab",
    traceId: "running-trace",
    status: "running",
    conversationKey: "b".repeat(64),
  };
  const host = {
    turnTabs: new Map([[ready.id, ready], [running.id, running]]),
    logger: { info: (event, detail) => releaseEvents.push([event, detail]) },
    removeTurnTab(tab, abortRunning) {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationKey: "b".repeat(64) }),
    });
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey: "b".repeat(64) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, released: 1 });
    assert.deepEqual(removed, ["ready-tab"]);
    assert.deepEqual([...host.turnTabs.keys()], ["running-tab"]);
    assert.deepEqual(releaseEvents, [["browser.tab_released", {
      tabId: "ready-tab",
      traceId: "ready-trace",
      status: "ready",
      reason: "retained_conversation_superseded",
    }]]);
  } finally {
    await server.close();
  }
});

test("browser control server rejects malformed retained-conversation contracts", async () => {
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => ({ beginTurn: () => assert.fail("invalid request reached browser host") }),
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  const post = (body) => fetch(`${descriptor.endpoint}/v1/turn/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ traceId: "abcdef123456", helperPid: process.pid, ...body }),
  });
  try {
    assert.equal((await post({ conversationKey: "ABC" })).status, 400);
    assert.equal((await post({ requireRetainedConversation: true })).status, 400);
    assert.equal((await post({ connectorIdentity: "Codex Native2" })).status, 400);
  } finally {
    await server.close();
  }
});

test("campaign control polls shared admission, rejects Pro and cancels queued work before creating a surface", async () => {
  const previous = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
  const starts = [];
  const diagnosticEvents = [];
  const host = {
    turnTabs: new Map(), browserInteractionMode: () => 'automatic',
    beginTurn: async (traceId, _reveal, helperPid) => { starts.push(traceId); host.turnTabs.set(traceId, { traceId, helperPid, status: 'running' }); return { surfaceId: traceId, reused: false, connectorBound: false }; },
    endTurn: async traceId => { host.turnTabs.delete(traceId); return { cancelledByUser: false }; },
    heartbeatTurn: (traceId, helperPid) => { assert.equal(host.turnTabs.get(traceId)?.helperPid, helperPid); },
  };
  const server = await new BrowserControlServer({ logger: {
    info() {}, warn() {},
    diagnostics: { event: (name, _body, _data, _severity, context) => diagnosticEvents.push({ name, context }) },
  }, getBrowserHost: () => host, getPreferences: () => ({}) }).start();
  const { endpoint, token } = server.descriptor();
  const post = (phase, traceId, extra = {}) => fetch(`${endpoint}/v1/turn/${phase}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }, body: JSON.stringify({ phase, traceId, helperPid: process.pid, queueAware: true, proGeneration: false, ...extra }) });
  try {
    assert.equal((await post('start', 'trace-pro', { proGeneration: true })).status, 403);
    assert.equal((await post('start', 'trace-old', { queueAware: false })).status, 403);
    for (const id of ['trace-one', 'trace-two', 'trace-three']) assert.equal((await post('start', id)).status, 202);
    assert.deepEqual(starts, ['trace-one', 'trace-two']);
    assert.equal((await post('start', 'trace-one')).status, 200);
    assert.equal((await post('park', 'trace-one', { revision: 1 })).status, 200);
    assert.equal(host.turnTabs.size, 3, 'parked parent keeps its page while queued child starts');
    assert.equal((await post('resume', 'trace-one', { revision: 1 })).status, 202);
    assert.equal((await post('end', 'trace-three', { status: 'aborted' })).status, 200);
    assert.equal((await post('resume', 'trace-one', { revision: 1 })).status, 200);
    assert.equal((await post('end', 'trace-one', { status: 'completed' })).status, 200);
    assert.deepEqual(diagnosticEvents.filter(event => ['browser.turn_started', 'browser.turn_ended'].includes(event.name))
      .map(event => [event.name, event.context.traceId, event.context.taskId]), [
      ['browser.turn_started', '11111111111111111111111111111111', 'trace-one'],
      ['browser.turn_ended', '11111111111111111111111111111111', 'trace-three'],
      ['browser.turn_ended', '11111111111111111111111111111111', 'trace-one'],
    ]);
    assert.equal(host.turnTabs.size, 1);
    assert.deepEqual(starts, ['trace-one', 'trace-two', 'trace-three']);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = previous;
  }
});
