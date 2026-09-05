/** Data-only integration contracts shared by the runtime and launcher renderer. */
export type SubagentProtocol = "compatibility-v1" | "native";
export type CodexConfigScalar = string | number | boolean;

export interface IntegrationTarget {
  id: string;
  kind: "base" | "profile";
  codexHome: string;
  configPath: string;
  runtimeHome: string;
  profile?: string;
}

export interface ConfigurationResolutionSelection { occurrenceId: string }

export interface ConfigurationReviewOccurrence {
  id: string;
  file: string;
  line: number;
  endLine: number;
  state: "active" | "commented_out";
  value: CodexConfigScalar | null;
  layer: "base" | "profile";
  ownership: "tracked" | "unclaimed";
}

export interface ConfigurationReviewSetting {
  path: string;
  current: CodexConfigScalar | null;
  proposed: CodexConfigScalar | null;
  state: "active" | "commented_out" | "missing" | "ambiguous";
  inherited: boolean;
  occurrences: ConfigurationReviewOccurrence[];
  findings: CodexIntegrationConflict[];
  baseline?: CodexConfigScalar;
  resolutionRequired: boolean;
  resolutionKind?: "assignment" | "table" | "route-section";
}

export interface ConfigurationReviewGroup {
  id: "connection" | "subagents" | "interrupt" | "catalog" | "runtime" | "other";
  settings: ConfigurationReviewSetting[];
}

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
  version: 1 | 2;
  status: "ready" | "blocked";
  approvalId: string;
  protocol: SubagentProtocol;
  changes: CodexRepairChange[];
  conflicts: CodexIntegrationConflict[];
  codexRestartRequired: boolean;
  launcherRestartRequired: boolean;
  effects?: string[];
  operation?: "setup" | "repair";
  /** Launcher-only transient state; never an approvable runtime plan. */
  refreshing?: boolean;
  textChanges?: Array<{ path: string; startLine: number; before: string; after: string }>;
  target?: IntegrationTarget;
  groups?: ConfigurationReviewGroup[];
  additionalTargets?: Array<{ target: IntegrationTarget; groups: ConfigurationReviewGroup[] }>;
  resolutions?: ConfigurationResolutionSelection[];
}
