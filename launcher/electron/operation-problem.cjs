const { problemFor } = require("./problems.cjs");

/** Attach the owning launcher span before a failed action crosses Electron IPC. */
function correlateFailedOperation(operation, context) {
  if (operation.status !== "failed") return operation;
  const existing = operation.problem;
  const sameTrace = !existing?.traceId || existing.traceId === context?.traceId;
  const correlation = {
    ...(!existing?.traceId && context?.traceId ? { traceId: context.traceId } : {}),
    ...(!existing?.spanId && sameTrace && context?.spanId ? { spanId: context.spanId } : {}),
  };
  return {
    ...operation,
    problem: problemFor(existing ? { problem: existing } : operation, operation.message, correlation),
  };
}

module.exports = { correlateFailedOperation };
