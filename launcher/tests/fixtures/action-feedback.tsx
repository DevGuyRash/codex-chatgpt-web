import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ActionFeedback } from "../../src/actions/feedback";
import { launcherActions } from "../../src/actions/controller";
import { observeLauncherOperation, withActionFeedback } from "../../src/actions/api";
import { CodexRestartContext, CodexRestartDialog, RestartOptions } from "../../src/CodexRestart";
import { NoticeRow } from "../../src/NoticeRow";
import { copyFor } from "../../src/i18n";
import { RecoveryContext, RecoveryDialog } from "../../src/Recovery";
import { DiagnosticsNavigationContext } from "../../src/diagnostics/navigation";
import type { Language, LauncherApi } from "../../src/types";
import type { CodexRestartAvailability } from "../../../src/contracts/codex-restart";
import "../../src/tokens.css";
import "../../src/styles.css";
import "../../src/diagnostics/styles.css";

const fixture = window as unknown as { language: Language; calls: string[]; availability?: CodexRestartAvailability; fail: () => void; succeed: () => void; smoke: () => Promise<unknown>; clear: () => void };
fixture.calls = [];
fixture.clear = () => launcherActions.clearHistory();
fixture.fail = () => observeLauncherOperation({ name: "runtime-start", status: "failed", message: "Ignored legacy text", problem: {
  version: 1, code: "codex_configuration_conflict", message: "Review Codex configuration", stage: "runtime-start", traceId: "a".repeat(32),
  findings: [{ path: "experimental_realtime_webrtc_call_base_url", message: "Managed realtime URL missing" }, { path: "hooks.Interrupt", message: "Interrupt hook differs" }],
  causes: [{ code: "fixture_related", message: "Synthetic related evidence" }], actions: ["review-configuration", "open-diagnostics"], recovery: "not-started",
} });
fixture.succeed = () => launcherActions.complete("setPreference", { status: "succeeded" });
fixture.smoke = () => withActionFeedback({ smokeTest: async () => ({ ok: true, effort: "standard", response: "PRIVATE_MODEL_RESPONSE" }) } as unknown as LauncherApi).smokeTest();
const api = {
  codexRestartAvailability: async () => fixture.availability ?? { status: "available" as const, token: "fixture-token", application: "Codex", location: "/fixture/Codex" },
  restartCodex: async (token: string) => { fixture.calls.push(`restart:${token}`); return { status: "launched" as const, application: "Codex" }; },
};
const doctorApi = withActionFeedback({ doctor: async () => ({ launcherActionFailure: true, problem: { version: 1, code: "fixture_doctor_failure", message: "Doctor could not inspect the fixture", findings: [{ path: "fixture.doctor", message: "Doctor-specific evidence" }], causes: [], actions: ["open-diagnostics"], recovery: "not-needed" } }) } as unknown as LauncherApi);
function Fixture() {
  const [open, setOpen] = useState(false);
  const [doctorOpen, setDoctorOpen] = useState(false);
  return <RecoveryContext.Provider value={action => fixture.calls.push(action)}>
    <DiagnosticsNavigationContext.Provider value={traceId => fixture.calls.push(`diagnostics:${traceId ?? "all"}`)}>
      <CodexRestartContext.Provider value={() => setOpen(true)}>
        <NoticeRow icon="alert" tone="warning" action={<RestartOptions language={fixture.language} />}>{copyFor(fixture.language).restartCodex}</NoticeRow>
      </CodexRestartContext.Provider>
      <button type="button" onClick={() => setDoctorOpen(true)}>Open Doctor</button>
      <ActionFeedback language={fixture.language} />
      {open ? <CodexRestartDialog api={api} language={fixture.language} onClose={() => setOpen(false)} /> : null}
      {doctorOpen ? <RecoveryDialog action="run-doctor" api={doctorApi} language={fixture.language} devProfile={false} onClose={() => setDoctorOpen(false)} onRepaired={() => { throw new Error("Unexpected fixture repair"); }} /> : null}
    </DiagnosticsNavigationContext.Provider>
  </RecoveryContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
