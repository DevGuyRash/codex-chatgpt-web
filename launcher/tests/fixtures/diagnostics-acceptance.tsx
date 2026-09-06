import { createRoot } from "react-dom/client";
import { DiagnosticsWorkspace } from "../../src/DiagnosticsWorkspace";
import { ActionFeedback } from "../../src/actions/feedback";
import { CaptureIndicator } from "../../src/diagnostics/CaptureIndicator";
import { DiagnosticsNavigationContext } from "../../src/diagnostics/navigation";
import { createElement } from "react";
import { unwrapDiagnosticResult } from "../../../src/diagnostics/request-error";
import type { DiagnosticsApi } from "../../../src/diagnostics/contracts";
import "../../src/tokens.css";
import "../../src/styles.css";

const listeners = new Set<() => void>();
const invoke = async (method: string, ...args: unknown[]) => {
  const response = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, args }) });
  return unwrapDiagnosticResult(await response.json());
};
const api: DiagnosticsApi = {
  status: () => invoke("status"), query: (query, id) => invoke("query", query, id), cancelQuery: id => invoke("cancel", id),
  capture: async command => { const result = await invoke("capture", command); for (const listener of listeners) listener(); return result; },
  clear: (scope, confirmed) => invoke("clear", scope, confirmed), export: options => invoke("export", options),
  copy: async options => { const result = await invoke("copy", options); await navigator.clipboard.writeText(result.text); return result.metadata; },
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
createRoot(document.getElementById("root")!).render(createElement(DiagnosticsNavigationContext.Provider, { value: () => {} }, <><CaptureIndicator api={api} language="en" open={() => {}} /><DiagnosticsWorkspace api={api} language="en" /><ActionFeedback language="en" /></>));
