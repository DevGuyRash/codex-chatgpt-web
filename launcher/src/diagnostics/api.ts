import type { DiagnosticsApi } from "../../../src/diagnostics/contracts";
import { unwrapDiagnosticResult, type DiagnosticFailure, type DiagnosticsBridgeApi } from "../../../src/diagnostics/request-error";

/** contextBridge strips custom Error properties, so unwrap only after arriving in the renderer. */
export function withDiagnosticErrors(api: DiagnosticsBridgeApi): DiagnosticsApi {
  const unwrap = async <T,>(result: Promise<T | DiagnosticFailure>): Promise<T> => {
    // The validated failure envelope throws; every remaining value has the API's success type.
    return unwrapDiagnosticResult(await result) as T;
  };
  return {
    status: () => unwrap(api.status()),
    query: (query, requestId) => unwrap(api.query(query, requestId)),
    cancelQuery: requestId => unwrap(api.cancelQuery(requestId)),
    capture: command => unwrap(api.capture(command)),
    clear: (scope, confirmed) => unwrap(api.clear(scope, confirmed)),
    export: options => unwrap(api.export(options)),
    copy: options => unwrap(api.copy(options)),
    ...(api.reviewSetup ? { reviewSetup: (traceId: string) => unwrap(api.reviewSetup!(traceId)) } : {}),
    subscribe: listener => api.subscribe(listener),
  };
}
