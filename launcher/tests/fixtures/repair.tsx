// Offline renderer fixture: real React/UI, substituted IPC and configuration.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { ConfigurationRepair } from "../../src/ConfigurationRepair";
import type { CodexRepairPreview, LauncherState } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = window as unknown as {
  preview: CodexRepairPreview;
  calls: string[];
  failApply: boolean;
};
fixture.calls = [];
fixture.failApply = false;
fixture.preview = {
  version: 1, status: "ready", approvalId: "a".repeat(64), protocol: "native",
  conflicts: [{ path: "features.multi_agent", category: "value_changed", current: false, expected: true, message: "A newer choice is preserved" }],
  changes: [{ path: "runtime.subagentProtocol", current: "compatibility-v1", proposed: "native" }],
  codexRestartRequired: true, launcherRestartRequired: true,
};
function Fixture() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <main style={{ maxWidth: 672, margin: "auto", padding: 20 }}>
    <ConfigurationRepair language="en" disabled={busy} onBusyChange={setBusy} onError={setError} onRepaired={() => { fixture.calls.push("repaired"); }} api={{
      previewIntegrationRepair: async protocol => { fixture.calls.push(`preview:${protocol}`); return { ...fixture.preview, protocol }; },
      applyIntegrationRepair: async (protocol, id) => {
        fixture.calls.push(`apply:${protocol}:${id}`);
        if (fixture.failApply) throw new Error("Repair inputs changed; review a fresh preview");
        return { state: {} as LauncherState };
      },
    }} />
    {error ? <p role="alert">{error}</p> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
