const test = require("node:test");
const assert = require("node:assert/strict");
const { ConfigurationReview, parseConfigurationPreview } = require("../electron/configuration-review.cjs");

const preview = { version: 1, status: "ready", protocol: "native", operation: "setup", approvalId: "a".repeat(64), changes: [], conflicts: [], codexRestartRequired: true, launcherRestartRequired: false };

test("changing protocol discards approval and expiry cannot later authorize setup", async () => {
  const review = new ConfigurationReview({ publish() {}, timeoutMs: 20 });
  const first = review.request(preview, async protocol => ({ ...preview, protocol, approvalId: "b".repeat(64) }));
  await review.decide(preview.approvalId, "compatibility-v1");
  assert.equal(review.snapshot().approvalId, "b".repeat(64));
  assert.throws(() => review.decide(preview.approvalId, true), /no longer current/);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(first, /expired/); }
  finally { clearTimeout(keepAlive); }
  assert.throws(() => review.decide(preview.approvalId, true), /no longer current/);
});

test("protocol refresh keeps one visible review, disables stale approval, and ignores results after cancellation", async () => {
  const events = [];
  let finishRefresh;
  const review = new ConfigurationReview({ publish: value => events.push(value) });
  const completion = review.request(preview, () => new Promise(resolve => { finishRefresh = resolve; }));
  const refresh = review.decide(preview.approvalId, "compatibility-v1");
  assert.equal(review.snapshot()?.refreshing, true);
  assert.equal(review.snapshot()?.protocol, "compatibility-v1");
  assert.equal(events.includes(null), false);
  assert.throws(() => review.decide(preview.approvalId, true), /current|refresh/);
  await Promise.resolve();
  review.cancel();
  await assert.rejects(completion, /cancelled/);
  finishRefresh({ ...preview, protocol: "compatibility-v1", approvalId: "b".repeat(64) });
  await refresh;
  assert.equal(review.snapshot(), null);
});

test("setup review retains only a pending preview and resolves only its explicit current decision", async () => {
  const events = [];
  const review = new ConfigurationReview({ publish: value => events.push(value) });
  const result = review.request(preview);
  assert.equal(review.snapshot(), preview);
  assert.throws(() => review.decide("stale", true), /no longer current/);
  await assert.rejects(review.request(preview), /Another configuration/);
  review.decide(preview.approvalId, true);
  assert.equal(await result, preview.approvalId);
  assert.equal(review.snapshot(), null);
  assert.deepEqual(events, [preview, null]);
  assert.throws(() => review.decide(preview.approvalId, true), /no longer current/);
});

test("cancelled and blocked configuration reviews cannot authorize setup", async () => {
  const review = new ConfigurationReview({ publish() {} });
  const result = review.request({ ...preview, status: "blocked", approvalId: "" });
  assert.throws(() => review.decide("", true), /Resolve configuration conflicts/);
  review.decide("", false);
  await assert.rejects(result, /no setup changes were applied/);
  const next = review.request(preview);
  review.cancel("Window closed");
  await assert.rejects(next, /Window closed/);
});

test("shared preview validation accepts source evidence and rejects malformed source metadata", () => {
  const value = { ...preview, changes: [{ path: "openai_base_url", current: null, proposed: "local", currentState: "commented_out", currentLines: [48] }] };
  assert.deepEqual(parseConfigurationPreview(JSON.stringify(value)), value);
  value.changes[0].currentLines = [-1];
  assert.throws(() => parseConfigurationPreview(JSON.stringify(value)), /malformed/);
});
