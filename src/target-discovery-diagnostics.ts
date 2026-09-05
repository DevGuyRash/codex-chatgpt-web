import type { IntegrationTarget, IntegrationTargetDiscovery } from "./contracts/codex-integration";
import type { DoctorCheck } from "./contracts/diagnostics";

export function targetDiscoveryChecks(discovery: IntegrationTargetDiscovery, selected?: IntegrationTarget): DoctorCheck[] {
  return [
    ...discovery.entries.filter(entry => entry.status !== "available").map((entry): DoctorCheck => ({
      id: `discovery-${entry.id}`,
      status: entry.status === "external" ? "ok" : entry.id === selected?.id ? "error" : "warning",
      code: `target_${entry.status}`,
      message: entry.status === "external" ? "This profile is managed elsewhere" : entry.id === selected?.id ? "The selected connection is unavailable" : "An optional profile is unavailable; it does not block the selected connection",
      findings: [{ path: entry.configPath, message: entry.status === "external" ? "Keep this link intact. Manage its settings at the resolved location." : "Inspect the file or link in your configuration manager. This app will not replace it." }, ...(entry.resolvedPath ? [{ path: entry.resolvedPath, message: "Resolved location" }] : [])],
    })),
    ...discovery.issues.map((issue, index): DoctorCheck => ({ id: `discovery-issue-${index}`, status: "warning", code: issue.code, message: "Some optional connections could not be discovered", findings: [{ path: issue.path, message: "Inspect this location and its permissions, then refresh connections. Do not delete ownership records to dismiss this warning." }] })),
  ];
}
