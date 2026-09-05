import { createRoot } from "react-dom/client";
import { useState } from "react";
import { copyFor } from "../../src/i18n";
import { ErrorToast, RecoveryContext, RecoveryDialog } from "../../src/Recovery";
import type { DiagnosticProblem, LauncherApi, RecoveryAction } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const problem: DiagnosticProblem = { code: "codex_configuration_conflict", message: "Codex integration is inconsistent", findings: [
  { path: "openai_base_url", message: "The route is commented out and inactive. Review the current file before applying changes." },
  { path: "features.multi_agent_v2", message: "Native V2 is enabled. The installed Compatibility V1 expectation is false.\nSelect the protocol you intend to use." },
], actions: ["review-configuration", "run-doctor"] };
const api = { doctor: async () => ({ ok: false, checks: [{ id: "codex", status: "error", message: problem.message, findings: problem.findings, problem }] }) } as LauncherApi;
function Fixture() {
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [dismissed, setDismissed] = useState(false);
  return <RecoveryContext.Provider value={setAction}><main>
    {action === "run-doctor" || action === "review-configuration" ? <RecoveryDialog key={action} action={action} api={api} language="en" devProfile={false} onClose={() => setAction(null)} onRepaired={() => { throw new Error("No writes are authorized by this fixture"); }} /> : null}
    {!dismissed ? <ErrorToast copy={copyFor("en")} language="en" message={problem.message} problem={problem} disabled={false} onDismiss={() => setDismissed(true)} /> : <p role="status">Dismissed</p>}
  </main></RecoveryContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
