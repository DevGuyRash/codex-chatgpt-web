import { createRoot } from "react-dom/client";
import { useState } from "react";
import { copyFor } from "../../src/i18n";
import { ErrorToast, RecoveryContext, RecoveryBusyContext, RecoveryDialog } from "../../src/Recovery";
import type { DiagnosticProblem, LauncherApi, LauncherState, RecoveryAction } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const problem: DiagnosticProblem = { code: "codex_configuration_conflict", message: "Codex integration is inconsistent", findings: [
  { path: "openai_base_url", message: "The route is commented out and inactive. Review the current file before applying changes." },
  { path: "features.multi_agent_v2", message: "Native V2 is enabled. The installed Compatibility V1 expectation is false.\nSelect the protocol you intend to use." },
], actions: ["review-configuration", "run-doctor"] };
const fixture = window as unknown as { recoveryCalls: string[] };
fixture.recoveryCalls = [];
let applied = false;
const api = {
  doctor: async () => { fixture.recoveryCalls.push("doctor"); return applied ? { ok: true, checks: [{ id: "codex", status: "ok", message: "Rechecked connection" }] } : { ok: false, checks: [{ id: "codex", status: "error", message: problem.message, findings: problem.findings, problem }] }; },
  previewIntegrationRepair: async protocol => ({ version: 1, status: "ready", approvalId: "a".repeat(64), protocol, changes: [], conflicts: [], codexRestartRequired: true, launcherRestartRequired: true }),
  applyIntegrationRepair: async () => { fixture.recoveryCalls.push("apply"); applied = true; return { state: { codexRestartRequired: true } as LauncherState }; },
} as LauncherApi;
function Fixture() {
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  return <RecoveryContext.Provider value={setAction}><RecoveryBusyContext.Provider value={busy}><main>
    <label><input type="checkbox" checked={busy} onChange={event => setBusy(event.target.checked)} />Other launcher operation in progress</label>
    {action === "run-doctor" || action === "review-configuration" ? <RecoveryDialog key={action} action={action} api={api} language="en" devProfile={false} onClose={() => setAction(null)} onRepaired={() => fixture.recoveryCalls.push("repaired")} /> : null}
    {!dismissed ? <ErrorToast copy={copyFor("en")} language="en" message={problem.message} problem={problem} disabled={false} onDismiss={() => setDismissed(true)} /> : <p role="status">Dismissed</p>}
  </main></RecoveryBusyContext.Provider></RecoveryContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
