import { createContext } from "react";
export const DiagnosticsNavigationContext = createContext<(traceId?: string) => void>(() => {});
