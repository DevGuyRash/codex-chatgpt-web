import type { IntegrationTarget } from "../../src/contracts/codex-integration";
export class RuntimeRegistry {
  constructor(options: { runtimeRoot: string });
  runtimeRoot: string;
  read(): { version: 1; targets: Array<{ target: IntegrationTarget; port: number }> };
  list(codexHome?: string): IntegrationTarget[];
  assertBaseOwner(target: IntegrationTarget): void;
  ensure(target: IntegrationTarget): Promise<{ target: IntegrationTarget; port: number }>;
}
