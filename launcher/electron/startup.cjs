const { DiagnosticError, problemFor, isDiagnosticCancellation } = require("./generated/diagnostics.cjs");

const reviewRequired = error => ["CONFIGURATION_REVIEW_REQUIRED", "codex_configuration_conflict", "codex_route_inconsistent"].includes(error?.code ?? error?.problem?.code);

// Startup owns the terminal outcome; child command success is only stage evidence.
async function runStartup({ logger, start, ready, notConfigured, recover, failed, cancelled }) {
  const operation = logger.diagnostics.begin("runtime-start");
  return operation.run(async () => {
    let runtimeStatus = "unknown";
    let recoveryResult;
    const restore = async () => {
      const recovery = logger.diagnostics.begin("runtime-start-route-recovery");
      return recovery.run(async () => {
        try { recoveryResult = await recover(); }
        catch (error) { recoveryResult = { restored: false, problem: problemFor(error, "The previous Codex route could not be restored; inspect configuration before retrying") }; }
        recovery.end(recoveryResult.problem ? "failed" : "succeeded", { "route.restored": recoveryResult.restored === true });
        return recoveryResult;
      });
    };
    try {
      const runtime = await start(status => { runtimeStatus = status; });
      runtimeStatus = runtime.status;
      if (runtime.status === "ready") {
        await ready(runtime);
        operation.end("succeeded", { "runtime.state": runtimeStatus, "integration.ready": true });
        return;
      }
      if (runtime.status === "not-configured") {
        await notConfigured();
        const recovery = await restore();
        if (recovery.problem) throw new DiagnosticError({ code: "runtime_not_configured", message: "The local runtime is not configured", actions: ["review-configuration", "open-diagnostics", "run-doctor"] });
        operation.end("succeeded", { "runtime.state": runtimeStatus, "integration.ready": false });
        return;
      }
      throw new DiagnosticError({ code: runtime.status === "external" ? "runtime_externally_owned" : "runtime_needs_setup",
        message: runtime.status === "external" ? "Another process owns the configured runtime; inspect its owner before changing integration" : "The local runtime needs setup before Codex can connect",
        actions: ["review-setup", "open-diagnostics", "run-doctor"] });
    } catch (error) {
      if (isDiagnosticCancellation(error)) {
        operation.end("cancelled", { "runtime.state": runtimeStatus, "integration.ready": false });
        await cancelled?.();
        return;
      }
      const primary = problemFor(error, "Startup could not establish a ready Codex integration; inspect the startup stages");
      // Inconsistent configuration requires review, not a second mutation attempt.
      const recovery = reviewRequired(error) ? undefined : recoveryResult ?? await restore();
      const problem = operation.problem({ problem: primary }, undefined, {
        recovery: reviewRequired(error) ? "not-started" : recovery?.problem ? "incomplete" : recovery?.restored ? "completed" : primary.recovery,
        causes: [...primary.causes, ...(recovery?.problem ? [{ code: recovery.problem.code, message: recovery.problem.message }] : [])].slice(0, 8),
      });
      operation.end("failed", { "runtime.state": runtimeStatus, "integration.ready": false });
      await failed(problem);
    }
  });
}

module.exports = { runStartup };
