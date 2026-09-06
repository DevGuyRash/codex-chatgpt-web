import { createRoot } from "react-dom/client";
import type { LauncherApi, LauncherSnapshot, Language, DiagnosticProblem } from "../../src/types";
import type { DiagnosticsApi } from "../../../src/diagnostics/contracts";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = (window as unknown as { fixture: { language: Language; problem: DiagnosticProblem } }).fixture;
const call = async (path: string, body?: unknown, signal?: AbortSignal) => {
  const response = await fetch(`/diagnostics/${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" }, signal });
  if (!response.ok) throw new Error("Synthetic diagnostic bridge failed");
  return response.json();
};
const listeners = new Set<() => void>();
const diagnostics: DiagnosticsApi = {
  status: () => call("status"), query: query => call("query", query), cancelQuery: async () => {},
  subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  capture: async command => { const result = await call("capture", command); for (const listener of listeners) listener(); return result; },
  clear: (scope, confirmed) => call("clear", { scope, confirmed }), export: async () => ({ cancelled: true }), copy: async () => {},
};
const snapshot: LauncherSnapshot = {
  profile: "development", profilePaths: { coreHome: "/fixture/runtime", codexHome: "/fixture/codex", userData: "/fixture/app" },
  state: { version: 1, language: fixture.language, onboardingComplete: true, githubOpened: true, xOpened: true, autoStart: false, keepRunningOnClose: false, showBrowserDuringTurns: false, browserInteractionMode: "manual", experimentalBiggerContext: true, zeroRiskProEnabled: false, sidebarOpen: false, sidebarWidth: 240, coreSetupComplete: true, codexCatalogVerified: true, mcpSetupComplete: true, mcpGuideStep: 0, sessionRefreshReminderAt: null },
  browser: null, connectorName: "Fixture", connectorNames: { automatic: "Fixture", manual: "Fixture" }, mcpCredentialsConfigured: true, urls: { github: "https://example.invalid", x: "https://example.invalid", connectors: "https://example.invalid", tunnels: "https://example.invalid", keys: "https://example.invalid" }, platform: "linux", packaged: false, version: "5.0.3", smokePassed: true,
  operation: { name: "fixture-approval", status: "failed", message: fixture.problem.message, problem: fixture.problem }, update: { status: "disabled" },
};
const subscribe = () => () => {};
// Only presentation seams exercised here are substituted. Missing mutation APIs fail if invoked.
window.codexWebLauncher = {
  diagnostics, snapshot: async () => snapshot, setBrowserSurfaceActive: async () => snapshot.browser, setBrowserBounds: async () => true,
  setSidebarState: async () => snapshot.state, windowState: async () => ({ fullScreen: false, maximized: false }),
  onStateChanged: subscribe, onBrowserState: subscribe, onConfigurationPreview: subscribe, onCodexRestartRequired: subscribe, onOperation: subscribe, onUpdateState: subscribe, onWindowStateChanged: subscribe,
} as unknown as LauncherApi;
const { App } = await import("../../src/App");
createRoot(document.getElementById("root")!).render(<App />);
