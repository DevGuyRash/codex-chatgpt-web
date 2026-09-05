// The test supplies the real main/preload decision transport and backend previews.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { SetupConfigurationReview } from "../../src/ConfigurationRepair";
import type { CodexRepairPreview } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = window as unknown as { beginReview: () => Promise<void> };
function Fixture() {
  const [preview, setPreview] = useState<CodexRepairPreview | null>(null);
  useEffect(() => window.codexWebLauncher!.onConfigurationPreview(setPreview), []);
  return <main><button type="button" onClick={() => void fixture.beginReview()}>Review configuration</button>
    {preview ? <SetupConfigurationReview language="en" preview={preview} decide={window.codexWebLauncher!.decideConfiguration} /> : null}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
