import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readLauncherBrowserHostDescriptor } from "../../src/launcher-browser-host";
import { goldenImplementationIdentity } from "./implementation";
import { GoldenQueue } from "./queue";
import type { GoldenWorkspace } from "./workspace";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ReviewSchema = z.object({ expectedImplementationSha256: z.string().regex(/^[a-f0-9]{64}$/), implementationSha256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().min(1).max(4096), verification: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict();
function retain(path: string, text: string): void {
  try { writeFileSync(path, text, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !lstatSync(path).isFile() || readFileSync(path, "utf8") !== text) throw error;
  }
}

/** Review and manifest artifacts precede the atomic queue cutover; leftover staged records never imply a cutover. */
export function reconcileGoldenImplementation(options: { root: string; repository: string; runtimeArtifacts: readonly string[]; reviewPath: string }) {
  const root = resolve(options.root), reviewPath = resolve(options.reviewPath), reviewStat = lstatSync(reviewPath);
  if (!reviewStat.isFile() || reviewStat.size > 1024 * 1024) throw new Error("Implementation reconciliation requires a bounded regular review file");
  const reviewText = readFileSync(reviewPath, "utf8"), review = ReviewSchema.parse(JSON.parse(reviewText));
  const current = goldenImplementationIdentity(options.repository, options.runtimeArtifacts);
  if (current.sha256 !== review.implementationSha256) throw new Error("The reviewed implementation differs from the current source and runtime artifacts");
  const queue = new GoldenQueue(join(root, "campaign.sqlite"));
  try {
    if (queue.implementationSha256 !== review.expectedImplementationSha256) throw new Error("The queue implementation changed since this review");
    if (queue.running().length) throw new Error("Unresolved attempts require evidence reconciliation before an implementation change");
    const retainedPrevious = join(root, "implementations", `${queue.implementationSha256}.json`);
    const previousText = readFileSync(existsSync(retainedPrevious) ? retainedPrevious : join(root, "campaign-implementation.json"), "utf8"), previous = JSON.parse(previousText);
    if (previous.sha256 !== queue.implementationSha256 || !Array.isArray(previous.records) || hash(JSON.stringify(previous.records)) !== previous.sha256) throw new Error("The prior implementation manifest does not match retained campaign coverage");
    const directory = join(root, "implementations"); mkdirSync(directory, { recursive: true, mode: 0o700 });
    retain(join(directory, `${previous.sha256}.json`), previousText);
    retain(join(directory, `${current.sha256}.json`), JSON.stringify(current, null, 2));
    const evidenceSha256 = hash(reviewText), evidence = join(directory, `review-${evidenceSha256}.json`);
    retain(evidence, reviewText);
    if (goldenImplementationIdentity(options.repository, options.runtimeArtifacts).sha256 !== current.sha256) throw new Error("Implementation changed while staging its review; the queue was not revised");
    const result = queue.reconcileImplementation({ expectedImplementationSha256: review.expectedImplementationSha256, implementationSha256: current.sha256, reason: review.reason, evidence, evidenceSha256 });
    return { ...result, implementationSha256: current.sha256, review: evidence, summary: queue.summary() };
  } finally { queue.close(); }
}

if (import.meta.main) {
  if (!process.argv[4]) throw new Error("Usage: reconcile.ts <campaign-root> <native-executable> <implementation-review.json>");
  const root = resolve(process.argv[2] ?? "context/golden/live"), executable = resolve(process.argv[3] ?? "/usr/lib/chatgpt/resources/codex");
  const workspace = JSON.parse(readFileSync(join(root, "workspace.json"), "utf8")) as GoldenWorkspace;
  if (workspace.root !== root) throw new Error("Reconciliation requires its exact owned campaign workspace");
  const descriptor = readLauncherBrowserHostDescriptor(workspace.descriptorPath);
  console.log(JSON.stringify(reconcileGoldenImplementation({ root, repository: resolve(import.meta.dir, "../.."), runtimeArtifacts: [executable, process.execPath, descriptor.helper.script], reviewPath: process.argv[4] ?? "" })));
}
