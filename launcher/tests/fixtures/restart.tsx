import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CodexRestartDialog } from "../../src/CodexRestart";
import type { Language } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = window as unknown as { language: Language; calls: string[] };
fixture.calls = [];
const api = {
  codexRestartAvailability: async () => ({ status: "available" as const, token: "owned-token", application: "Codex", location: "/fixture/Codex" }),
  restartCodex: async (token: string) => { fixture.calls.push(token); return { status: "manual" as const, reason: "timeout" as const }; },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>Open restart</button>{open ? <CodexRestartDialog api={api} language={fixture.language} onClose={() => setOpen(false)} /> : null}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
