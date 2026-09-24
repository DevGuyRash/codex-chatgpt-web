import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { containsPath } from "../../src/diagnostics/paths";
import type { WorkloadLevel } from "./catalog";
import { createFormatFixtures } from "./formats";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const GOLDEN_UNICODE_WITNESS = "東京 → café → Δοκιμή → مرحبا";
export function largeHistoryWitness(workload: GoldenWorkload): string {
  // The generated seed is runner-owned and absent from the disposable repository.
  // A public dataset ID must not let the continuation recompute its witness.
  return `history-${sha256(`golden-large-history:${workload.seed}:${workload.batch}`).slice(0, 32)}`;
}
const comparable = (value: unknown): unknown => Array.isArray(value) ? value.map(comparable) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, comparable(child)])) : value;
interface Order { id: string; team: string; label: string; units: number; unitPriceCents: number; discountBps: number }
export interface GoldenWorkload {
  version: 2; id: string; level: WorkloadLevel; batch: number; seed: string;
  prompt: string; minimumProgressMs: number; files: Record<string, string>;
  binaryFiles: Record<string, Uint8Array>; attachmentAnswers: Record<string, string>;
  formatCoverage?: "all";
}
export function structuredScenarioPrompts(workload: GoldenWorkload) {
  const witness = `steering-${workload.id.slice(0, 24)}`;
  return {
    prepare: `Read the following task and identify its required outputs. Do not implement it yet; execution will follow in this same task.\n\n${workload.prompt}`,
    continue: "Execute the task described in the preceding turn, including its required outputs, independent validation and artifact commit.",
    plan: `Plan this task, including its tool and validation steps:\n\n${workload.prompt}`,
    revision: "Revise the plan to make independent validation and recovery from invalid input explicit. Preserve the task's required outputs.",
    execute: `Execute the task using the revised plan:\n\n${workload.prompt}`,
    steer: `Additional requirement for this task: write output/steering.txt containing exactly ${witness} followed by a newline, and include it in the artifact commit. Preserve the original task requirements.`,
    witness,
  };
}
const ResultSchema = z.object({
  datasetId: z.string(), recordsSeen: z.number().int(), validRecords: z.number().int(), rejectedIds: z.array(z.string()), grandTotalCents: z.number().int(),
  byTeam: z.array(z.object({ team: z.string(), count: z.number().int(), totalCents: z.number().int() }).strict()),
  samples: z.array(z.object({ id: z.string(), totalCents: z.number().int() }).strict()), facts: z.record(z.string(), z.string()),
}).strict();

/** One generator and prompt contract for every effort; model choice cannot simplify a workload. */
export function createWorkload(input: { level: WorkloadLevel; seed: string; batch: number; formatCoverage?: "all" }): GoldenWorkload {
  if (![1, 2, 3, 4, 5].includes(input.level) || !Number.isSafeInteger(input.batch) || input.batch < 0 || !input.seed || input.seed.length > 512) throw new Error("Invalid workload identity");
  const id = sha256(JSON.stringify([2, input.level, input.seed, input.batch, ...(input.formatCoverage ? [input.formatCoverage] : [])]));
  const documents = input.level >= 2 || input.formatCoverage === "all", image = input.level >= 3 || input.formatCoverage === "all";
  let state = Number.parseInt(id.slice(0, 8), 16) || 1;
  const random = (max: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
  const count = { 1: 12, 2: 250, 3: 1500, 4: 25000, 5: 7500 }[input.level];
  const orders: Order[] = Array.from({ length: count }, (_, index) => ({
    id: `order-${String(index).padStart(6, "0")}`, team: ["amber", "blue", "green"][random(3)]!, label: ["東京", "café", "Δοκιμή", "مرحبا", "naïve"][index % 5]!,
    units: input.level >= 3 && index % 97 === 0 ? -1 : 1 + random(25), unitPriceCents: 100 + random(4900), discountBps: [0, 500, 1250, 2000][random(4)]!,
  }));
  const adjustments = input.level >= 2 ? orders.filter((_, index) => index % 11 === 3).map(row => `${row.id},${1 + random(20)}`).join("\n") : "";
  const facts = input.level >= 3 ? {
    dispatchCode: `${["orchid", "cedar", "violet"][random(3)]}-${random(9999)}`,
    unicodeWitness: GOLDEN_UNICODE_WITNESS,
    revisedPolicy: `Revision-${input.batch + 1}-${random(1000)}`,
  } : {};
  const files: Record<string, string> = {
    "input/orders.json": JSON.stringify(orders, null, 2) + "\n",
    "input/adjustments.csv": `id,replacementUnits\n${adjustments}${adjustments ? "\n" : ""}`,
    "input/facts.md": `# Dispatch facts\n\n${Object.entries(facts).map(([key, value]) => `- ${key}: ${value}`).join("\n")}\n`,
    "input/spec.md": `# Order reconciliation\n\nDataset: ${id}\n\nEach order has a unique id. Replace units using the matching CSV row, then validate: units must be a nonnegative integer, unitPriceCents a nonnegative integer, and discountBps an integer between 0 and 10000 inclusive. Reject invalid orders and continue; do not count them toward totals. For every valid order, net cents = floor(units * unitPriceCents * (10000 - discountBps) / 10000). Do not round individual floating-point currency values.\n\nWrite output/result.json with exactly these fields: datasetId (the dataset identifier above), recordsSeen (all input orders), validRecords, rejectedIds (sorted by id), grandTotalCents, byTeam (sorted by team; each object has team, count, totalCents), samples (the first and last valid order in input order, each with id and totalCents), and facts (key/value pairs from input/facts.md, excluding its heading). Preserve the facts exactly, including Unicode.\n\nWrite output/report.md as a readable explanation identifying the dataset and the grand total in integer cents. ${input.level >= 2 ? "Write output/teams.csv with header team,count,totalCents and the same sorted team totals." : ""}\n`,
  };
  if (input.level >= 3) {
    files["project/README.md"] = "# Reconciliation project\n\nImplement project/analyze.ts as a reusable Bun CLI. Arguments are an input directory and dataset ID. Read orders.json, adjustments.csv and facts.md from that directory, and print only the result JSON specified by input/spec.md. Invalid rows are expected recoverable data errors; one invalid row must not abort the project. The independent runner will execute the CLI against additional generated input.\n";
    files["input/recovery.md"] = "# Recovery exercise\n\nThe optional input/prior-export.json does not exist. Use the source orders and corrections as the authority; absence of the optional prior export is an expected recoverable condition.\n";
  }
  if (input.level >= 4) {
    files["input/dossier.md"] = `# Generated operational dossier\n\nEach numbered observation is synthetic supporting context. Source orders, corrections and dispatch facts remain authoritative.\n\n${orders.map((row, index) => `## Observation ${index + 1}\n\n${row.id} belongs to ${row.team}. The shipment label is ${row.label}. Reconcile the source order with any correction before computing its value. Observation identity: ${sha256(`${id}:${row.id}`)}.\n`).join("\n")}\n`;
  }
  const formats = documents ? createFormatFixtures(id, image) : { files: {}, answers: {} };
  if (documents) files["input/spec.md"] += `\nInterpret the references inside input/dispatch.pdf, input/dispatch.docx and input/dispatch.xlsx${image ? ", and read the two-digit visual code in input/label.png" : ""}. Write output/attachments.json with exactly these string fields: ${Object.keys(formats.answers).join(", ")}. Preserve leading zeroes in the image code. These attachment results are separate from the reusable reconciliation CLI's JSON contract.\n`;
  if (input.formatCoverage === "all" && input.level === 1) files["input/spec.md"] += "\nWrite output/teams.csv with header team,count,totalCents and the same sorted team totals.\n";
  const prompt = `Complete the synthetic reconciliation workload in this repository (level ${input.level}, batch ${input.batch}, dataset ${id}). Read input/spec.md and its source files, produce output/result.json and the other required artifacts, and explain any recoverable data issues in output/report.md. Preserve input files. ${input.level >= 2 ? "Interpret the supplied document and image fixtures as required by the specification. " : ""}${input.level >= 3 ? "Implement the reusable project described in project/README.md, verify it with tools, and recover from expected missing or invalid input without fabricating data. " : ""}${input.level >= 4 ? "Use input/dossier.md when maintaining your working context; retain the dispatch facts through any continuation or compaction. " : ""}${input.level === 5 ? "This is one batch in a sustained task. The runner supplies additional batches after independent validation until at least two hours of observed active progress; do useful work now and finish this batch without waiting or claiming that the duration requirement is satisfied. " : ""}Commit the completed artifacts in this disposable repository. Your final message is explanatory; independent artifacts and protocol evidence determine acceptance.`;
  return { version: 2, id, ...input, files, binaryFiles: formats.files, attachmentAnswers: formats.answers, prompt, minimumProgressMs: input.level === 5 ? 2 * 60 * 60 * 1000 : 0 };
}

function expectedResult(workload: GoldenWorkload): z.infer<typeof ResultSchema> {
  const orders = JSON.parse(workload.files["input/orders.json"]!) as Order[];
  const replacements = new Map(workload.files["input/adjustments.csv"]!.trim().split("\n").slice(1).map(line => { const [id, units] = line.split(","); return [id!, Number(units)] as const; }));
  const totals: { id: string; totalCents: number }[] = [], rejectedIds: string[] = [];
  const teams = new Map<string, { team: string; count: number; totalCents: number }>();
  let grandTotalCents = 0;
  for (const row of orders) {
    const units = replacements.get(row.id) ?? row.units;
    if (!Number.isInteger(units) || units < 0 || !Number.isInteger(row.unitPriceCents) || row.unitPriceCents < 0 || !Number.isInteger(row.discountBps) || row.discountBps < 0 || row.discountBps > 10000) { rejectedIds.push(row.id); continue; }
    // BigInt arithmetic is independent of the floating-point implementation a model may choose.
    const totalCents = Number(BigInt(units) * BigInt(row.unitPriceCents) * BigInt(10000 - row.discountBps) / 10000n);
    totals.push({ id: row.id, totalCents }); grandTotalCents += totalCents;
    const team = teams.get(row.team) ?? { team: row.team, count: 0, totalCents: 0 };
    team.count++; team.totalCents += totalCents; teams.set(row.team, team);
  }
  const facts = Object.fromEntries(workload.files["input/facts.md"]!.split("\n").flatMap(line => { const match = /^- ([^:]+): (.*)$/.exec(line); return match ? [[match[1]!, match[2]!]] : []; }));
  return { datasetId: workload.id, recordsSeen: orders.length, validRecords: totals.length, rejectedIds: rejectedIds.sort(), grandTotalCents, byTeam: [...teams.values()].sort((a, b) => a.team.localeCompare(b.team)), samples: [totals[0]!, totals.at(-1)!], facts };
}

export function materializeWorkload(rootInput: string, workload: GoldenWorkload): void {
  const root = resolve(rootInput); mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error("Workload root must be an owned real directory");
  for (const [name, text] of Object.entries({ ...workload.files, ...workload.binaryFiles })) {
    const path = resolve(root, name);
    if (!containsPath(root, path)) throw new Error("Workload input escaped its root");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("Workload directory aliases another location");
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  }
  mkdirSync(join(root, "output"), { recursive: true, mode: 0o700 });
  if (realpathSync(join(root, "output")) !== join(root, "output")) throw new Error("Workload output directory aliases another location");
}

/** Artifact correctness only. Drivers additionally own commit, settlement, capture and variant evidence. */
export function evaluateWorkload(rootInput: string, workload: GoldenWorkload, projectExecution?: { validationWorkload: GoldenWorkload; stdout: string }, variant = "fresh") {
  const root = resolve(rootInput), failures: string[] = [], pendingChecks: string[] = [], artifacts: { path: string; bytes: number; sha256: string }[] = [];
  if (variant === "formats" && workload.formatCoverage !== "all") failures.push("Format coverage lacks the full shared fixture set");
  const readBytes = (name: string, maxBytes = 16 * 1024 * 1024) => {
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || !containsPath(realpathSync(root), realpathSync(path))) throw new Error("Invalid artifact");
      const data = readFileSync(path); artifacts.push({ path: name, bytes: data.byteLength, sha256: sha256(data) }); return data;
    } catch { failures.push(`Missing, oversized, or aliased artifact: ${name}`); return undefined; }
  };
  const read = (name: string, maxBytes = 16 * 1024 * 1024) => readBytes(name, maxBytes)?.toString("utf8");
  for (const [name, text] of Object.entries(workload.files)) {
    const actual = read(name);
    if (name.startsWith("input/") && actual !== undefined && actual !== text) failures.push(`Input changed: ${name}`);
  }
  for (const [name, bytes] of Object.entries(workload.binaryFiles)) {
    const actual = readBytes(name);
    if (actual && !actual.equals(Buffer.from(bytes))) failures.push(`Input changed: ${name}`);
  }
  const expected = expectedResult(workload);
  const checkResult = (text: string | undefined, expected: z.infer<typeof ResultSchema>, prefix: string) => {
    if (text === undefined) return;
    try {
      const actual = ResultSchema.parse(JSON.parse(text));
      for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (JSON.stringify(comparable(actual[key])) !== JSON.stringify(comparable(expected[key]))) failures.push(`${prefix}.${key} differs from the independent calculation`);
    } catch { failures.push(`${prefix} is not valid result JSON`); }
  };
  checkResult(read("output/result.json", 1024 * 1024), expected, "result");
  const report = read("output/report.md", 1024 * 1024);
  if (report !== undefined && (!report.includes(workload.id) || !report.includes(String(expected.grandTotalCents)))) failures.push("Readable report lacks the dataset identity or independently calculated total");
  if (workload.level >= 2 || workload.formatCoverage === "all") {
    const attachments = read("output/attachments.json", 1024 * 1024);
    if (attachments !== undefined) {
      try { if (JSON.stringify(comparable(JSON.parse(attachments))) !== JSON.stringify(comparable(workload.attachmentAnswers))) failures.push("Attachment interpretation differs from the generated fixture references"); }
      catch { failures.push("Attachment interpretation is not valid JSON"); }
    }
    const csv = read("output/teams.csv", 1024 * 1024);
    const expectedCsv = `team,count,totalCents\n${expected.byTeam.map(row => `${row.team},${row.count},${row.totalCents}`).join("\n")}`;
    if (csv !== undefined && csv.trim().replace(/\r\n/g, "\n") !== expectedCsv) failures.push("Team CSV differs from the independent calculation");
  }
  if (workload.level >= 3) {
    read("project/analyze.ts", 1024 * 1024);
    if (projectExecution) {
      if (projectExecution.validationWorkload.id === workload.id) failures.push("Project validation reused its original dataset");
      else checkResult(projectExecution.stdout, expectedResult(projectExecution.validationWorkload), "project");
    } else pendingChecks.push("Execute the generated project against an independent dataset in the native sandbox");
  }
  if (variant === "large-history") {
    const witness = read("output/history-witness.txt", 1024);
    if (witness !== undefined && witness !== `${largeHistoryWitness(workload)}\n`) failures.push("Large-history witness differs from the retained preparation fact");
  }
  if (variant === "unicode") {
    const witness = read("output/unicode.txt", 1024);
    if (witness !== undefined && witness !== `${GOLDEN_UNICODE_WITNESS}\n`) failures.push("Unicode witness differs from the required UTF-8 artifact");
  }
  if (variant.startsWith("steer-")) {
    const witness = read("output/steering.txt", 1024);
    if (witness !== undefined && witness !== `${structuredScenarioPrompts(workload).witness}\n`) failures.push("The steering correction is missing from its required artifact");
  }
  return { passed: failures.length === 0 && pendingChecks.length === 0, failures, pendingChecks, artifacts };
}
