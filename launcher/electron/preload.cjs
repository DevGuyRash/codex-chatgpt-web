const { contextBridge, ipcRenderer } = require("electron");
const { unwrapDiagnosticResult } = require("../../src/diagnostics/request-error.ts");
const invoke = (...args) => ipcRenderer.invoke(...args).then(unwrapDiagnosticResult);
const { createDiagnosticsBridge } = require("../diagnostics/preload.ts");

function subscription(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexWebLauncher", {
  diagnostics: createDiagnosticsBridge(ipcRenderer),
  snapshot: () => invoke("launcher:snapshot"),
  integrationTargets: () => invoke("launcher:integration-targets"),
  chooseCodexHome: () => invoke("launcher:codex-home-folder"),
  codexRestartAvailability: () => invoke("launcher:codex-restart-availability"),
  restartCodex: (token) => invoke("launcher:codex-restart-execute", token),
  onCodexRestartRequired: (listener) => subscription("launcher:codex-restart-required", listener),
  openIntegrationTarget: (target) => invoke("launcher:target-open", target),
  checkTargetCapabilities: () => invoke("launcher:target-check"),
  setLanguage: (language) => invoke("launcher:set-language", language),
  openSocial: (target) => invoke("launcher:open-social", target),
  completeOnboarding: (language, browserInteractionMode) => invoke(
    "launcher:complete-onboarding",
    language,
    browserInteractionMode,
  ),
  openExternal: (url) => invoke("launcher:open-external", url),
  setBrowserBounds: (bounds) => invoke("launcher:browser-bounds", bounds),
  setBrowserSurfaceActive: (active) => invoke("launcher:browser-surface-active", active),
  showBrowser: () => invoke("launcher:browser-show"),
  hideBrowser: () => invoke("launcher:browser-hide"),
  navigateBrowser: (action) => invoke("launcher:browser-navigate", action),
  zoomBrowser: (action) => invoke("launcher:browser-zoom", action),
  selectBrowserTab: (tabId) => invoke("launcher:browser-tab-select", tabId),
  closeBrowserTab: (tabId) => invoke("launcher:browser-tab-close", tabId),
  copyManualPrompt: (tabId) => invoke("launcher:manual-prompt-copy", tabId),
  confirmManualSent: (tabId) => invoke("launcher:manual-prompt-sent", tabId),
  openLogin: () => invoke("launcher:browser-login"),
  openPasskeyLogin: () => invoke("launcher:browser-passkey-login"),
  continuePasskeyLogin: () => invoke("launcher:browser-passkey-login-continue"),
  logoutChatGpt: () => invoke("launcher:browser-logout"),
  dismissSessionReminder: () => invoke("launcher:session-reminder-dismiss"),
  smokeTest: () => invoke("launcher:browser-smoke"),
  verifyMcp: () => invoke("launcher:mcp-verify"),
  doctor: () => invoke("launcher:doctor"),
  decideConfiguration: (approvalId, approved) => invoke("launcher:configuration-decision", approvalId, approved),
  previewIntegrationRepair: (protocol, resolutions) => invoke("launcher:repair-preview", protocol, resolutions),
  applyIntegrationRepair: (protocol, approvalId, resolutions) => invoke("launcher:repair-apply", protocol, approvalId, resolutions),
  cancelTurns: () => invoke("launcher:cancel-turns"),
  uninstallIntegration: () => invoke("launcher:uninstall-integration"),
  setupCore: (options) => invoke("launcher:setup-core", options),
  setupMcp: (input) => invoke("launcher:setup-mcp", input),
  setMcpStep: (step) => invoke("launcher:set-mcp-step", step),
  setAutostart: (enabled) => invoke("launcher:autostart", enabled),
  setBiggerContext: (enabled) => invoke("launcher:bigger-context", enabled),
  setZeroRiskPro: (enabled) => invoke("launcher:zero-risk-pro", enabled),
  setBrowserInteractionMode: (mode) => invoke("launcher:browser-interaction-mode", mode),
  setPreference: (key, value) => invoke("launcher:set-preference", key, value),
  setSidebarState: (state) => invoke("launcher:sidebar-state", state),
  exportLogs: () => invoke("launcher:export-logs"),
  installUpdate: () => invoke("launcher:update-install"),
  windowState: () => invoke("launcher:window-state"),
  windowControl: (action) => ipcRenderer.send("launcher:window-control", action),
  onWindowStateChanged: (listener) => subscription("launcher:window-state-changed", listener),
  onStateChanged: (listener) => subscription("launcher:state-changed", listener),
  onBrowserState: (listener) => subscription("launcher:browser-state", listener),
  onOperation: (listener) => subscription("launcher:operation", listener),
  onConfigurationPreview: (listener) => subscription("launcher:configuration-preview", listener),
  onUpdateState: (listener) => subscription("launcher:update-state", listener),
});
