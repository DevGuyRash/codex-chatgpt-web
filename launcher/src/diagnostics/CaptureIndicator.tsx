import type { DiagnosticsApi } from "../../../src/diagnostics/contracts";
import type { Language } from "../types";
import { diagnosticsCopy } from "./copy";
import { useDiagnostics } from "./use-diagnostics";

export function CaptureIndicator({ api, language, open }: { api: DiagnosticsApi; language: Language; open: () => void }) {
  const { state } = useDiagnostics(api);
  const { now } = state;
  const privateUntil = state.status?.captures.privateUntil ?? 0;
  const debugUntil = state.status?.captures.debugUntil ?? 0;
  const until = privateUntil > now ? privateUntil : debugUntil;
  if (until <= now) return null;
  const copy = diagnosticsCopy[language]; const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return <div className="capture-indicator"><span role="status">{privateUntil > now ? copy.privateActive : copy.debugActive}</span><span aria-label={copy.expires}>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span><button type="button" onClick={open}>{copy.capture}</button></div>;
}
