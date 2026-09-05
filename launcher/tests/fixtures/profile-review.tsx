import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { IntegrationTargets } from "../../src/IntegrationTargets";
import { SetupConfigurationReview } from "../../src/ConfigurationRepair";
import type { CodexRepairPreview, LauncherApi } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = (window as unknown as { profileFixture: { targets: Awaited<ReturnType<LauncherApi["integrationTargets"]>>; preview: CodexRepairPreview } }).profileFixture;
function Fixture() {
  const [preview, setPreview] = useState<CodexRepairPreview | null>(null);
  const finish = useRef<(() => void) | null>(null);
  const api = {
    integrationTargets: async () => fixture.targets,
    openIntegrationTarget: async () => ({ target: fixture.targets.selected }),
    checkTargetCapabilities: async () => ({ cancelled: true }),
    setupCore: async () => { setPreview(fixture.preview); await new Promise<void>(resolve => { finish.current = resolve; }); return { ok: true, stdout: "", restartRequired: true }; },
  };
  return <main><IntegrationTargets api={api} language="en" disabled={false} />
    {preview ? <SetupConfigurationReview language="en" preview={preview} decide={async (_id, approved) => { if (approved === false) { setPreview(null); finish.current?.(); } }} /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
