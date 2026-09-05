import type { CodexIntegrationConflict } from "./contracts/codex-integration";

/** Findings remain data across planning boundaries; the message is only the terminal fallback. */
export class CodexConfigurationError extends Error {
  readonly code = "codex_configuration_conflict";
  constructor(readonly conflicts: CodexIntegrationConflict[]) {
    super(conflicts.map(conflict => `${conflict.path}: ${conflict.message}`).join("\n"));
    this.name = "CodexConfigurationError";
  }
}
