import { expect, test } from "bun:test";
import { buildGoldenMatrix, matrixSummary, variants } from "../scripts/golden/catalog";

test("golden coverage is the complete declared product, with explicit Pro and compatibility exclusions", () => {
  const matrix = buildGoldenMatrix({ inspectedAt: "2026-09-08T00:00:00Z", source: "launcher-session-inspection", capabilities: { solAvailable: true, proAvailable: true }, nativeCodexVersion: "fixture", nativeCatalogSha256: "a".repeat(64) });
  expect(matrix.length).toBe(5 * 5 * 2 * variants.length * 2 + 5 * 2 * 2);
  expect(new Set(matrix.map(cell => cell.id)).size).toBe(matrix.length);
  expect(matrix.filter(cell => cell.route.adapterEffort === "max").every(cell => cell.exclusion?.includes("Pro generation"))).toBe(true);
  expect(matrix.filter(cell => cell.route.adapterEffort === "xhigh" && cell.variant.id === "fresh").every(cell => cell.status === "pending")).toBe(true);
  expect(matrixSummary(matrix).minimumLevelFiveGenerationHours).toBeGreaterThan(0);
  expect(matrix.every(cell => cell.status !== "passed")).toBe(true);
});
