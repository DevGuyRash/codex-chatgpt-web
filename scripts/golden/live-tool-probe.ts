import { createHash, randomUUID } from "node:crypto";
import { runLiveBatch } from "./live-batch";

/** One ordinary live level-one tool boundary, using the same owner as paired batches. */
export async function probeLiveTools(root: string, executable: string, sourceHome?: string, signal: AbortSignal = new AbortController().signal, variant: "fresh" | "plan-revise-execute" = "fresh") {
  const summary = await runLiveBatch({ root, executable, sourceHome, signal, boundary: "ordinary-native-tools", turnTimeoutMs: 10 * 60 * 1000,
    cells: [{ id: createHash("sha256").update(randomUUID()).digest("hex"), routeSlug: "chatgpt-web/light", workload: 1, variant }],
  });
  const cell = summary.cells[0];
  return { ...summary, variant, result: cell?.result ? { ...cell.result, selections: cell.selections, toolItems: cell.result.terminal.toolItems, baseline: cell.result.commit.baseline, head: cell.result.commit.head, clean: cell.result.commit.clean } : undefined,
    ...(!summary.passed && (summary.problem || cell?.error) ? { error: (summary.problem ?? cell?.error)!.message } : {}),
  };
}

if (import.meta.main) {
  const controller = new AbortController(), stop = () => controller.abort(new Error("Live tool probe observation was cancelled"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const variant = process.argv[5] ?? "fresh";
    if (variant !== "fresh" && variant !== "plan-revise-execute") throw new Error("Unsupported live tool probe variant");
    console.log(JSON.stringify(await probeLiveTools(process.argv[2] ?? "context/golden/live", process.argv[3] ?? "/usr/lib/chatgpt/resources/codex", process.argv[4], controller.signal, variant)));
  }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
