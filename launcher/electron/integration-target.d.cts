import type { IntegrationTarget, IntegrationTargetDiscovery } from "../../src/contracts/codex-integration";
export function canonicalConfigurationPath(path: string): string;
export function resolveIntegrationTarget(options?: { codexHome?: string; profile?: string; runtimeRoot?: string }): IntegrationTarget;
export function listIntegrationTargets(options?: { codexHome?: string; runtimeRoot?: string }): IntegrationTarget[];
export function discoverIntegrationTargets(options?: { codexHome?: string; runtimeRoot?: string }): IntegrationTargetDiscovery;
export function integrationLaunch(target: IntegrationTarget, executable?: string): { executable: string; args: string[]; env: Record<string, string> };
export function integrationLaunchCommand(launch: ReturnType<typeof integrationLaunch>, platform?: NodeJS.Platform): string;
export function validateIntegrationTarget(value: unknown, owningRuntimeHome?: string): IntegrationTarget;
export function integrationConnectorNames(target?: import("../../src/contracts/codex-integration").IntegrationTarget): { automatic: string; manual: string };
