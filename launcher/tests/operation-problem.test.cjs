const assert = require("node:assert/strict");
const test = require("node:test");
const { correlateFailedOperation } = require("../electron/operation-problem.cjs");

test("a plain launcher action failure opens the exact diagnostic trace", () => {
  const traceId = "a".repeat(32), spanId = "b".repeat(16);
  const operation = correlateFailedOperation({
    name: "launcher:browser-extension-install", status: "failed",
    message: "Choose an extension from the official Chrome Web Store catalog",
  }, { traceId, spanId });
  assert.equal(operation.problem.code, "operation_failed");
  assert.equal(operation.problem.traceId, traceId);
  assert.equal(operation.problem.spanId, spanId);
  assert.ok(operation.problem.actions.includes("open-diagnostics"));
});

test("a structured child failure keeps its own trace instead of mixing launcher ownership", () => {
  const childTrace = "c".repeat(32), launcherTrace = "a".repeat(32);
  const operation = correlateFailedOperation({
    name: "runtime-start", status: "failed", message: "The child failed",
    problem: { version: 1, code: "child_failed", message: "The child failed", traceId: childTrace,
      findings: [], causes: [], actions: ["open-diagnostics"], recovery: "unknown" },
  }, { traceId: launcherTrace, spanId: "b".repeat(16) });
  assert.equal(operation.problem.traceId, childTrace);
  assert.equal(operation.problem.spanId, undefined);
});

test("non-failures and failures without an observed span do not gain invented correlation", () => {
  const completed = { name: "browser-smoke", status: "completed" };
  assert.equal(correlateFailedOperation(completed, { traceId: "a".repeat(32) }), completed);
  const failed = correlateFailedOperation({ name: "browser-smoke", status: "failed", message: "Could not complete" });
  assert.equal(failed.problem.traceId, undefined);
});
