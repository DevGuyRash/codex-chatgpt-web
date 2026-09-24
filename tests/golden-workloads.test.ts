import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GOLDEN_UNICODE_WITNESS, createWorkload, evaluateWorkload, materializeWorkload } from "../scripts/golden/workloads";

test("shared workloads are deterministic, vary across batches, and preserve Unicode input", () => {
  for (const level of [1, 2, 3, 4, 5] as const) {
    const workload = createWorkload({ level, seed: "fixed-fixture", batch: 0 });
    expect(workload).toEqual(createWorkload({ level, seed: "fixed-fixture", batch: 0 }));
    expect(workload.id).not.toBe(createWorkload({ level, seed: "fixed-fixture", batch: 1 }).id);
    expect(workload.files["input/orders.json"]).toContain("東京");
    expect(workload.prompt).toContain("output/result.json");
    expect(workload.minimumProgressMs).toBe(level === 5 ? 2 * 60 * 60 * 1000 : 0);
    const formats = createWorkload({ level, seed: "fixed-fixture", batch: 0, formatCoverage: "all" });
    expect(formats.id).not.toBe(workload.id);
    expect(Object.keys(formats.binaryFiles)).toHaveLength(4);
    expect(formats.files["input/spec.md"]).toContain("output/attachments.json");
    expect(formats.files["input/spec.md"]).toContain("output/teams.csv");
  }
});

test.each([undefined, "all"] as const)("the independent artifact oracle rejects fabricated completion, incorrect arithmetic and changed inputs (formats=%s)", formatCoverage => {
  const root = mkdtempSync(join(tmpdir(), "golden-workload-"));
  try {
    const workload = createWorkload({ level: 1, seed: "arithmetic", batch: 0, formatCoverage });
    materializeWorkload(root, workload);
    expect(evaluateWorkload(root, workload).passed).toBe(false);
    // Independently derive the level-one answer from the public input, not the oracle implementation.
    const rows = JSON.parse(readFileSync(join(root, "input/orders.json"), "utf8"));
    const teams: Record<string, { count: number; totalCents: number }> = {};
    let grandTotalCents = 0;
    const totals = rows.map((row: { id: string; team: string; units: number; unitPriceCents: number; discountBps: number }) => {
      const totalCents = Math.floor(row.units * row.unitPriceCents * (10000 - row.discountBps) / 10000);
      const team = teams[row.team] ??= { count: 0, totalCents: 0 };
      team.count++; team.totalCents += totalCents; grandTotalCents += totalCents;
      return { id: row.id, totalCents };
    });
    const result = { datasetId: workload.id, recordsSeen: rows.length, validRecords: rows.length, rejectedIds: [], grandTotalCents, byTeam: Object.entries(teams).sort(([a], [b]) => a.localeCompare(b)).map(([team, value]) => ({ team, ...value })), samples: [totals[0], totals.at(-1)], facts: {} };
    writeFileSync(join(root, "output/result.json"), JSON.stringify(result));
    writeFileSync(join(root, "output/report.md"), `# Result\n\nDataset ${workload.id}: ${grandTotalCents} cents.\n`);
    if (formatCoverage === "all") {
      expect(Object.keys(workload.binaryFiles).sort()).toEqual(["input/dispatch.docx", "input/dispatch.pdf", "input/dispatch.xlsx", "input/label.png"]);
      expect(evaluateWorkload(root, workload).passed).toBeFalse();
      writeFileSync(join(root, "output/attachments.json"), JSON.stringify({ ...workload.attachmentAnswers, imageCode: "wrong" }));
      writeFileSync(join(root, "output/teams.csv"), `team,count,totalCents\n${result.byTeam.map(row => `${row.team},${row.count},${row.totalCents}`).join("\n")}\n`);
      expect(evaluateWorkload(root, workload).failures).toContain("Attachment interpretation differs from the generated fixture references");
      writeFileSync(join(root, "output/attachments.json"), JSON.stringify(workload.attachmentAnswers));
    }
    expect(evaluateWorkload(root, workload)).toMatchObject({ passed: true, failures: [] });
    expect(evaluateWorkload(root, workload, undefined, "formats").passed).toBe(formatCoverage === "all");
    expect(evaluateWorkload(root, workload, undefined, "unicode").passed).toBe(false);
    writeFileSync(join(root, "output/unicode.txt"), "Almost the same\n");
    expect(evaluateWorkload(root, workload, undefined, "unicode").failures).toContain("Unicode witness differs from the required UTF-8 artifact");
    writeFileSync(join(root, "output/unicode.txt"), `${GOLDEN_UNICODE_WITNESS}\n`);
    const unicode = evaluateWorkload(root, workload, undefined, "unicode");
    expect(unicode.passed).toBe(true);
    expect(unicode.artifacts.map(artifact => artifact.path)).toContain("output/unicode.txt");
    expect(evaluateWorkload(root, workload, undefined, "steer-generation").passed).toBe(false);
    writeFileSync(join(root, "output/steering.txt"), "Acknowledged the correction.\n");
    expect(evaluateWorkload(root, workload, undefined, "steer-generation").passed).toBe(false);
    writeFileSync(join(root, "output/steering.txt"), `steering-${workload.id.slice(0, 24)}\n`);
    const steered = evaluateWorkload(root, workload, undefined, "steer-generation");
    expect(steered.passed).toBe(true);
    expect(steered.artifacts.map(artifact => artifact.path)).toContain("output/steering.txt");
    writeFileSync(join(root, "output/result.json"), JSON.stringify({ ...result, grandTotalCents: grandTotalCents + 1 }));
    expect(evaluateWorkload(root, workload).failures).toContain("result.grandTotalCents differs from the independent calculation");
    writeFileSync(join(root, "input/orders.json"), "[]");
    expect(evaluateWorkload(root, workload).failures).toContain("Input changed: input/orders.json");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
