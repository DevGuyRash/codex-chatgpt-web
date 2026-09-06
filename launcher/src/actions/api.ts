import type { LauncherApi, LauncherBridgeApi, OperationState } from "../types";
import { withDiagnosticErrors } from "../diagnostics/api";
import { ProblemSchema } from "../../../src/diagnostics/contracts";
import { classifyAction, launcherActions } from "./controller";

// Every launcher API member has an explicit feedback policy. New controls cannot silently bypass it.
export const launcherActionPolicy = {
  diagnostics: "owned", integrationTargets: "quiet", chooseCodexHome: "work", codexRestartAvailability: "quiet", restartCodex: "work", onCodexRestartRequired: "quiet",
  openIntegrationTarget: "work", checkTargetCapabilities: "work", snapshot: "quiet", setLanguage: "work", openSocial: "work", completeOnboarding: "work", openExternal: "work",
  setBrowserBounds: "quiet", setBrowserSurfaceActive: "quiet", showBrowser: "quiet", hideBrowser: "quiet", navigateBrowser: "quiet", zoomBrowser: "quiet", selectBrowserTab: "quiet", closeBrowserTab: "quiet",
  copyManualPrompt: "work", confirmManualSent: "work", openLogin: "work", openPasskeyLogin: "work", continuePasskeyLogin: "work", logoutChatGpt: "work", dismissSessionReminder: "quiet",
  smokeTest: "work", verifyMcp: "work", doctor: "work", decideConfiguration: "quiet", onConfigurationPreview: "quiet", previewIntegrationRepair: "work", applyIntegrationRepair: "work",
  cancelTurns: "work", uninstallIntegration: "work", setupCore: "work", setupMcp: "work", setMcpStep: "quiet", setAutostart: "work", setBiggerContext: "work", setZeroRiskPro: "work", setBrowserInteractionMode: "work", setPreference: "work", setSidebarState: "quiet", exportLogs: "work", installUpdate: "work",
  windowState: "quiet", windowControl: "quiet", onWindowStateChanged: "quiet", onStateChanged: "quiet", onBrowserState: "quiet", onOperation: "quiet", onUpdateState: "quiet",
} as const satisfies Record<keyof LauncherApi, "quiet" | "owned" | "work">;

export class PresentedActionError extends Error {
  constructor(readonly original: unknown) { super(original instanceof Error ? original.message : "Launcher action failed"); this.name = "PresentedActionError"; }
}
export function actionErrorMessage(error: unknown): string { return error instanceof PresentedActionError ? "" : error instanceof Error ? error.message : String(error); }
const operationMethods: Record<string, string> = { "core-setup": "setupCore", "mcp-setup": "setupMcp", "bigger-context": "setBiggerContext", "zero-risk-pro": "setZeroRiskPro", "browser-interaction-mode": "setBrowserInteractionMode", "cancel-active-turns": "cancelTurns", "runtime-upgrade": "review-setup", doctor: "doctor", "mcp-verification": "verifyMcp", "browser-smoke": "smokeTest" };
export function observeLauncherOperation(operation: OperationState) {
  const key = operationMethods[operation.name] ?? operation.name;
  const parsed = ProblemSchema.safeParse(operation.problem);
  if (launcherActions.isActive(key)) {
    if (parsed.success) launcherActions.correlate(key, parsed.data);
    return; // The awaited API result owns completion; intermediate child stages do not.
  }
  if (operation.status === "failed") launcherActions.complete(key, { status: "failed", problem: parsed.success ? parsed.data : undefined, traceId: operation.problem?.traceId });
  if (operation.status === "cancelled") launcherActions.complete(key, { status: "cancelled", traceId: operation.problem?.traceId });
}
const wrappers = new WeakMap<LauncherBridgeApi, LauncherApi>();
export function withActionFeedback(api: LauncherBridgeApi): LauncherApi {
  const existing = wrappers.get(api); if (existing) return existing;
  const methods = new Map<PropertyKey, unknown>();
  // Electron's contextBridge freezes exposed properties; a proxy must not override that frozen target.
  const wrapped = new Proxy({ ...api, diagnostics: api.diagnostics ? withDiagnosticErrors(api.diagnostics) : api.diagnostics } as LauncherApi, { get(target, property, receiver) {
    const original: unknown = Reflect.get(target, property, receiver);
    if (typeof original !== "function" || launcherActionPolicy[property as keyof LauncherApi] !== "work") return original;
    if (!methods.has(property)) {
      const pending: { args: unknown[]; result: Promise<unknown> }[] = [];
      methods.set(property, (...args: unknown[]) => {
        const duplicate = pending.at(-1);
        if (duplicate && duplicate.args.length === args.length && duplicate.args.every((value, index) => Object.is(value, args[index]))) return duplicate.result;
        const execute = () => launcherActions.run(String(property), () => Promise.resolve(Reflect.apply(original, target, args)), {
      classify: value => {
        if (property === "chooseCodexHome" || property === "exportLogs") return value === null ? "cancelled" : "succeeded";
        if (value === false) return "failed";
        if (property === "openIntegrationTarget" || property === "installUpdate") return "accepted";
        if (property === "restartCodex") return value?.status === "launched" ? "accepted" : "failed";
        if (property === "setAutostart" && value?.supported === false) return "failed";
        return classifyAction(value);
      },
        }).then(result => { if (result.error) throw new PresentedActionError(result.error); return result.value; });
        // Serialize differing requests for one API method. Arguments stay in memory and never become notice keys.
        const previous = pending.at(-1)?.result;
        const result = previous ? previous.then(execute, execute) : execute();
        const entry = { args, result };
        pending.push(entry);
        const remove = () => { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); };
        void result.then(remove, remove);
        return result;
      });
    }
    return methods.get(property);
  } });
  wrappers.set(api, wrapped); return wrapped;
}
