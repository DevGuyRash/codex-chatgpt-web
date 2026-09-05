const { redactText } = require("./logging.cjs");

// Single recovery policy for operation failures and Doctor results. No text matching
// and no executable commands supplied by child output. All writes retain their owners.
const recovery = Object.freeze({
  codex_configuration_conflict: ["review-configuration", "run-doctor"],
  codex_route_missing: ["review-setup", "run-doctor"],
});
function problemFor(error, fallback = "The operation could not complete") {
  const code = typeof error?.code === "string" && Object.hasOwn(recovery, error.code) ? error.code : "operation_failed";
  const findings = Array.isArray(error?.findings) ? error.findings.slice(0, 512).flatMap(item =>
    item && typeof item.message === "string" ? [{
      ...(typeof item.path === "string" ? { path: redactText(item.path.slice(0, 4096)) } : {}),
      message: redactText(item.message.slice(0, 4096)),
    }] : []) : [];
  return { code, message: redactText(typeof error?.message === "string" ? error.message : fallback), findings,
    actions: [...(recovery[code] || ["run-doctor", "export-logs"])] };
}
function withRecovery(report) {
  return { ...report, checks: report.checks.map(check => check.status === "ok" ? check : {
    ...check, problem: { ...problemFor(check, check.message), actions: Object.hasOwn(recovery, check.code ?? "") ? recovery[check.code] : ["export-logs"] },
  }) };
}
function runtimeFailure(stderr, fallback) {
  const prefix = "CGW_ERROR_V1 ";
  const line = stderr.split(/\r?\n/).find(line => line.startsWith(prefix));
  if (line) {
    try {
      const data = JSON.parse(line.slice(prefix.length));
      if (data?.version === 1 && data.code === "codex_configuration_conflict" && typeof data.message === "string" && Array.isArray(data.findings)) {
        return Object.assign(new Error(data.message), problemFor(data));
      }
    } catch { /* Unknown/malformed child output has no recovery authority. */ }
    return new Error("The runtime returned an unsupported structured error. Run Doctor or refresh the local runtime build.");
  }
  return new Error(fallback);
}
module.exports = { problemFor, withRecovery, runtimeFailure };
