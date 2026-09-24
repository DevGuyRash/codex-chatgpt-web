const CONNECTION_ID = /^[0-9a-f-]{36}$/;
const RESPONSE_CLASSES = new Set([
  "browser-verification-failed", "notification", "success", "failure", "browser-support-failure", "error",
]);
const VERIFICATION_REASONS = new Set(["unknown-browser", "signature-invalid"]);
const MAX_ACTIVE_CONNECTIONS = 128;

function createNativeHostLifecycle({ logger, providerIds }) {
  const active = new Map();
  let limitReported = false;

  function observe(details) {
    if (!details || !providerIds.has(details.extensionId)
      || !CONNECTION_ID.test(details.connectionId || "")
      || !["started", "response", "exit"].includes(details.phase)) return;
    const base = { id: details.extensionId, connectionId: details.connectionId, phase: details.phase };
    if (details.phase === "started") {
      if (!active.has(details.connectionId) && active.size >= MAX_ACTIVE_CONNECTIONS) {
        if (!limitReported) logger.warn("browser.extension_native_host_limit", { activeCount: active.size });
        limitReported = true;
        return;
      }
      if (active.has(details.connectionId)) return;
      active.set(details.connectionId, { classification: null, verificationReason: null });
      logger.info("browser.extension_native_host", base);
      return;
    }
    if (details.phase === "exit") {
      active.delete(details.connectionId);
      if (active.size < MAX_ACTIVE_CONNECTIONS) limitReported = false;
      const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
      logger[exitCode === 0 ? "info" : "warn"]("browser.extension_native_host", { ...base, exitCode });
      return;
    }
    const connection = active.get(details.connectionId);
    if (!connection) return;
    const classification = RESPONSE_CLASSES.has(details.responseClass) ? details.responseClass : "other";
    const verificationReason = classification === "browser-verification-failed"
      ? VERIFICATION_REASONS.has(details.verificationReason) ? details.verificationReason : "other"
      : null;
    if (connection.classification === classification && connection.verificationReason === verificationReason) return;
    connection.classification = classification;
    connection.verificationReason = verificationReason;
    const event = { ...base, classification, ...(verificationReason ? { verificationReason } : {}) };
    logger[["browser-verification-failed", "failure", "browser-support-failure", "error"].includes(classification)
      ? "warn" : "info"]("browser.extension_native_host", event);
  }

  return { observe, destroy: () => active.clear(), activeCount: () => active.size };
}

module.exports = { createNativeHostLifecycle };
