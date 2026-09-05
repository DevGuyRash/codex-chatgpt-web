const test = require("node:test");
const assert = require("node:assert/strict");
const { problemFor, withRecovery, runtimeFailure } = require("../electron/problems.cjs");

test("operation and doctor findings use the same allowlisted recovery policy", () => {
  const source = { code: "codex_configuration_conflict", message: "Configuration differs", findings: [{ path: "features.multi_agent_v2", message: "Changed by the user" }] };
  const error = runtimeFailure(`CGW_ERROR_V1 ${JSON.stringify({ version: 1, ...source, actions: ["delete-files"] })}\n`, "failed");
  const problem = problemFor(error);
  assert.deepEqual(problem.actions, ["review-configuration", "run-doctor"]);
  assert.deepEqual(withRecovery({ ok: false, checks: [{ id: "codex", status: "error", ...source }] }).checks[0].problem, problem);
  assert.deepEqual(problem.findings, source.findings);
});
test("unknown messages never imply mutation or configuration ownership", () => {
  for (const message of ["Please repair Codex", "CGW_ERROR_V1 invalid", 'CGW_ERROR_V1 {"version":1,"code":"delete-files"}']) {
    assert.deepEqual(problemFor(runtimeFailure(message, message)).actions, ["run-doctor", "export-logs"]);
  }
  assert.deepEqual(problemFor({ code: "codex_route_missing", message: "Absent" }).actions, ["review-setup", "run-doctor"]);
  assert.doesNotMatch(runtimeFailure('CGW_ERROR_V1 {"private":"not-for-logs"}', "not-for-logs").message, /not-for-logs/);
});
