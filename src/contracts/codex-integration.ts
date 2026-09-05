/** Data-only integration contracts shared by the runtime and launcher renderer. */
export type SubagentProtocol = "compatibility-v1" | "native";
export type CodexConfigScalar = string | number | boolean;

export interface CodexIntegrationConflict {
  path: string;
  category: "missing" | "commented_out" | "value_changed" | "hook_changed" | "invalid_config" | "ownership_conflict";
  message: string;
  expected?: CodexConfigScalar;
  current?: CodexConfigScalar | null;
}

export interface CodexRepairChange {
  path: string;
  current: CodexConfigScalar | null;
  proposed: CodexConfigScalar | null;
  currentState?: "active" | "commented_out" | "missing";
  currentLines?: number[];
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
  effects?: string[];
  operation?: "setup" | "repair";
  textChanges?: Array<{ path: string; startLine: number; before: string; after: string }>;
}
