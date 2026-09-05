// Offline renderer fixture: real modal and shared diff; decision transport is substituted.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { SetupConfigurationReview } from "../../src/ConfigurationRepair";
import type { CodexRepairPreview } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

function Fixture() {
  const [result, setResult] = useState("");
  const [preview, setPreview] = useState<CodexRepairPreview | null>({
    version: 1, operation: "setup", status: "ready", approvalId: "a".repeat(64), protocol: "native",
    changes: [{ path: "openai_base_url", current: null, proposed: "http://127.0.0.1:17841/v1", currentState: "commented_out", currentLines: [48] }],
    textChanges: [{ path: "config.toml", startLine: 48, before: '# openai_base_url = "local"\n', after: 'openai_base_url = "http://127.0.0.1:17841/v1"\n' }],
    effects: ["Update the selected runtime after configuration succeeds."], conflicts: [], codexRestartRequired: true, launcherRestartRequired: false,
  });
  return <main><p role="status">{result}</p>{preview ? <SetupConfigurationReview key={preview.approvalId} preview={preview} language="en" decide={async (_id, decision) => {
    if (typeof decision === "string") setPreview({ ...preview, protocol: decision, approvalId: "b".repeat(64) });
    else { setResult(decision ? "Approved" : "Cancelled"); setPreview(null); }
  }} /> : null}</main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
