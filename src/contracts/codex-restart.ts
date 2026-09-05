export type RestartReason = "busy" | "stale" | "ambiguous" | "not-found" | "unsupported" | "discovery-failed" | "timeout" | "restart-failed";
export type CodexRestartAvailability = { status: "available"; token: string; application: string; location: string } | { status: "manual"; reason: RestartReason; application?: string; location?: string };
export type CodexRestartResult = { status: "launched"; application: string } | { status: "manual"; reason: RestartReason };
