/** Data-only integration contracts shared by the runtime and launcher renderer. */
export type SubagentProtocol = "compatibility-v1" | "native";
export type CodexConfigScalar = string | number | boolean;

export interface CodexIntegrationConflict {
  path: string;
  category: "missing" | "value_changed" | "hook_changed" | "invalid_config" | "ownership_conflict";
  message: string;
  expected?: CodexConfigScalar;
  current?: CodexConfigScalar | null;
}

export interface CodexRepairChange {
  path: string;
  current: CodexConfigScalar | null;
  proposed: CodexConfigScalar | null;
}

export interface CodexRepairPreview {
  version: 1;
  status: "ready" | "blocked";
  approvalId: string;
  protocol: SubagentProtocol;
  changes: CodexRepairChange[];
  conflicts: CodexIntegrationConflict[];
  codexRestartRequired: boolean;
  launcherRestartRequired: boolean;
}
