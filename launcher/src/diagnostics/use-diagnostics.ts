import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DiagnosticsApi } from "../../../src/diagnostics/contracts";
import { diagnosticsController } from "./controller";

export function useDiagnostics(api: DiagnosticsApi) {
  const controller = useMemo(() => diagnosticsController(api), [api]);
  useEffect(() => controller.acquire(), [controller]);
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.getSnapshot) };
}
