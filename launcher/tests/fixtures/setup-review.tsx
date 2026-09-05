// Offline renderer fixture: real modal and shared diff; decision transport is substituted.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SetupConfigurationReview } from "../../src/ConfigurationRepair";
import type { CodexRepairPreview } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

function Fixture() {
  const [result, setResult] = useState("");
  const [preview, setPreview] = useState<CodexRepairPreview | null>(window.location.hash === "#blocked" ? {
    version: 1, operation: "setup", status: "blocked", approvalId: "", protocol: "native", changes: [],
    conflicts: [{ path: "setup", category: "ownership_conflict", message: "The selected setup inputs need attention.\nResolve the missing prerequisite before requesting a new preview." }],
    codexRestartRequired: true, launcherRestartRequired: false,
  } : {
    version: 1, operation: "setup", status: "ready", approvalId: "a".repeat(64), protocol: "native",
    changes: [{ path: "openai_base_url", current: null, proposed: "http://127.0.0.1:17841/v1", currentState: "commented_out", currentLines: [48] }],
    textChanges: [{ path: "config.toml", startLine: 48, before: '# openai_base_url = "local"\n', after: 'openai_base_url = "http://127.0.0.1:17841/v1"\n' }],
    effects: ["Update the selected runtime after configuration succeeds."], conflicts: [{ path: "features.multi_agent_v2", category: "value_changed", current: true, expected: false, message: "Native V2 is enabled. Native preserves this user choice; Compatibility V1 proposes disabling it." }], codexRestartRequired: true, launcherRestartRequired: false,
  });
  return <main><p role="status">{result}</p>{preview ? <SetupConfigurationReview preview={preview} language="en" decide={async (_id, decision) => {
    if (typeof decision === "string") {
      setPreview({ ...preview, protocol: decision, approvalId: "", refreshing: true });
      await new Promise<void>(resolve => window.addEventListener("complete-preview", () => resolve(), { once: true }));
      setPreview(current => current ? { ...preview, protocol: decision, approvalId: "b".repeat(64), changes: [...preview.changes, { path: "features.multi_agent_v2", current: true, proposed: false }] } : null);
    }
    else { setResult(decision ? "Approved" : "Cancelled"); setPreview(null); }
  }} /> : null}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
