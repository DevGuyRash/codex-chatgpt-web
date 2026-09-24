import { createHash } from "node:crypto";
import { availableChatGptWebModelRoutes, CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, type ChatGptWebAccountCapabilities, type ChatGptWebModelRoute } from "../../src/chatgpt-web-models";
import { isProGeneration } from "../../src/campaign-policy";

export const CATALOG_VERSION = 1;
export type WorkloadLevel = 1 | 2 | 3 | 4 | 5;
export type Driver = "exec" | "app-server" | "tui" | "assisted";
export type ExecutionLane = "serial" | "concurrent";
export type Protocol = "compatibility-v1" | "native";
export type CellStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "unsupported" | "substituted";
export interface CapabilitySnapshot {
  inspectedAt: string;
  source: "launcher-session-inspection";
  capabilities: ChatGptWebAccountCapabilities;
  nativeCodexVersion: string;
  nativeCatalogSha256: string;
}
export interface Variant { id: string; driver: Driver; requiresImage?: boolean; controlledFault?: string; }

const phases = ["reasoning", "generation", "tools", "queue"] as const;
export const variants: readonly Variant[] = [
  ...["fresh", "resumed", "archived-history", "formats", "tool-failure", "large-tool-result", "tool-image", "nested-delegation", "cross-effort-delegation", "multipart", "unicode", "large-history", "retained-conversation-change"].map(id => ({ id, driver: "exec" as const })),
  { id: "compaction", driver: "app-server" },
  { id: "model-switch", driver: "app-server" },
  { id: "continued", driver: "app-server" },
  { id: "plan-revise-execute", driver: "app-server" },
  { id: "plan-stream-interrupt", driver: "app-server" },
  { id: "plan-tui-execute", driver: "tui" },
  ...phases.flatMap(phase => [false, true].map(requiresImage => ({ id: `steer-${phase}${requiresImage ? "-image" : ""}`, driver: "app-server" as const, requiresImage }))),
  ...phases.map(phase => ({ id: `stop-${phase}-continue`, driver: "app-server" as const })),
  ...["permission-card", "connector-identity-mismatch", "connector-metadata-mismatch", "expired-binding", "authentication-expiry", "cdp-disconnect", "helper-interruption", "runtime-interruption", "delayed-acknowledgement", "uncertain-submission"].map(id => ({ id, driver: "app-server" as const, controlledFault: id })),
  { id: "queue-contention-cancel", driver: "app-server" },
  { id: "zero-risk-assisted", driver: "assisted" },
];

export interface GoldenCell {
  id: string;
  catalogVersion: number;
  capabilitySnapshotSha256: string;
  route: ChatGptWebModelRoute;
  workload: WorkloadLevel;
  protocol: Protocol;
  variant: Variant;
  lane: ExecutionLane;
  status: CellStatus;
  exclusion?: string;
}

export function buildGoldenMatrix(snapshot: CapabilitySnapshot): GoldenCell[] {
  if (!Number.isFinite(Date.parse(snapshot.inspectedAt)) || snapshot.source !== "launcher-session-inspection" || !/^[a-f0-9]{64}$/.test(snapshot.nativeCatalogSha256) || !snapshot.nativeCodexVersion) throw new Error("Golden matrix requires an actual capability inspection and native catalog identity");
  const capabilitySnapshotSha256 = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const routes = availableChatGptWebModelRoutes({ ...snapshot.capabilities, browserInteractionMode: "automatic" });
  const result: GoldenCell[] = [];
  for (const route of routes) for (const workload of [1, 2, 3, 4, 5] as const) for (const protocol of ["compatibility-v1", "native"] as const) for (const variant of variants) for (const lane of ["serial", "concurrent"] as const) {
    const exclusion = isProGeneration(route) ? "Pro generation requires separate user sign-off after non-Pro acceptance."
      : variant.id === "zero-risk-assisted" ? "Automatic model routes cannot substitute for manual Zero Risk selection; covered by the separate assisted lane."
      : (variant.id === "model-switch" || variant.id === "cross-effort-delegation") && routes.filter(candidate => !isProGeneration(candidate)).length < 2 ? "The inspected account exposes only one permitted automatic model route."
      : variant.id === "multipart" && !snapshot.capabilities.solAvailable ? "Luna uses rolling checkpoints and does not support the Sol multipart input path."
      : undefined;
    const identity = JSON.stringify([CATALOG_VERSION, capabilitySnapshotSha256, route.slug, workload, protocol, variant.id, lane]);
    result.push({ id: createHash("sha256").update(identity).digest("hex"), catalogVersion: CATALOG_VERSION, capabilitySnapshotSha256, route, workload, protocol, variant, lane, status: isProGeneration(route) ? "blocked" : exclusion ? "unsupported" : "pending", ...(exclusion ? { exclusion } : {}) });
  }
  const route = CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, variant = variants.find(candidate => candidate.id === "zero-risk-assisted")!;
  for (const workload of [1, 2, 3, 4, 5] as const) for (const protocol of ["compatibility-v1", "native"] as const) for (const lane of ["serial", "concurrent"] as const) {
    const identity = JSON.stringify([CATALOG_VERSION, capabilitySnapshotSha256, route.slug, workload, protocol, variant.id, lane]);
    result.push({ id: createHash("sha256").update(identity).digest("hex"), catalogVersion: CATALOG_VERSION, capabilitySnapshotSha256, route, workload, protocol, variant, lane, status: "pending" });
  }
  return result;
}

export function matrixSummary(cells: readonly GoldenCell[]) {
  const runnable = cells.filter(cell => !cell.exclusion);
  const levelFive = runnable.filter(cell => cell.workload === 5);
  return {
    total: cells.length, compatible: runnable.length, excluded: cells.length - runnable.length,
    minimumLevelFiveGenerationHours: levelFive.length * 2,
    // This lower bound excludes other levels, setup, validation and account rate-limit backoff.
    minimumLevelFiveWallHours: levelFive.reduce((hours, cell) => hours + (cell.lane === "serial" ? 2 : 1), 0),
  };
}
