import type { IpcRenderer } from "electron";
import type { DiagnosticsBridgeApi } from "../../src/diagnostics/request-error";

export function createDiagnosticsBridge(ipc: IpcRenderer): DiagnosticsBridgeApi {
  const invoke = (channel: string, ...args: unknown[]) => ipc.invoke(channel, ...args);
  return {
    status: () => invoke("launcher:diagnostics-status"),
    query: (query, requestId = crypto.randomUUID()) => invoke("launcher:diagnostics-query", query, requestId),
    cancelQuery: requestId => invoke("launcher:diagnostics-cancel", requestId),
    capture: command => invoke("launcher:diagnostics-capture", command),
    clear: (scope, confirmed) => invoke("launcher:diagnostics-clear", scope, confirmed),
    export: options => invoke("launcher:diagnostics-export", options),
    copy: query => invoke("launcher:diagnostics-copy", query),
    reviewSetup: traceId => invoke("launcher:diagnostics-review-setup", traceId),
    subscribe: listener => { const handler = () => listener(); ipc.on("launcher:diagnostics-changed", handler); return () => { ipc.removeListener("launcher:diagnostics-changed", handler); }; },
  };
}
