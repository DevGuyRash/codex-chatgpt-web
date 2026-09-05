import { createRoot } from "react-dom/client";
import { ConfigurationChanges } from "../../src/ConfigurationRepair";
import { IntegrationTargets } from "../../src/IntegrationTargets";
import type { CodexRepairPreview, Language, LauncherApi } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";
const fixture = (window as unknown as { fixture: { preview: CodexRepairPreview; language: Language; targets: Awaited<ReturnType<LauncherApi["integrationTargets"]>> } }).fixture;
const api = { integrationTargets: async () => fixture.targets, openIntegrationTarget: async () => ({ target: fixture.targets.selected }), checkTargetCapabilities: async () => ({ cancelled: true }), setupCore: async () => { throw new Error("No installation is authorized by this fixture"); } };
createRoot(document.getElementById("root")!).render(<main style={{ maxWidth: 850, padding: 20, margin: "auto" }}><IntegrationTargets api={api} language={fixture.language} disabled={false} /><ConfigurationChanges preview={fixture.preview} language={fixture.language} /></main>);
