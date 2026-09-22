import { z } from "zod";
import { ProblemSchema } from "./contracts";
import { DiagnosticError } from "./problems";
import { safeProblem } from "./privacy";

export const ActionFailureSchema = z.object({ launcherActionFailure: z.literal(true), problem: ProblemSchema }).strict();
export type ActionFailure = z.infer<typeof ActionFailureSchema>;

// Plain data must cross both Electron IPC and contextBridge before reconstructing an Error.
export function actionFailure(error: unknown): ActionFailure | undefined {
  const parsed = ProblemSchema.safeParse(error && typeof error === "object" && "problem" in error ? error.problem : undefined);
  return parsed.success ? { launcherActionFailure: true, problem: safeProblem(parsed.data) } : undefined;
}

export function unwrapActionResult<T>(value: T): T {
  if (value && typeof value === "object" && "launcherActionFailure" in value && value.launcherActionFailure === true) {
    const parsed = ActionFailureSchema.safeParse(value);
    throw new DiagnosticError(parsed.success ? parsed.data.problem : { code: "unsupported_problem", message: "The launcher returned an unsupported problem record; inspect component versions in Diagnostics", actions: ["open-diagnostics"] });
  }
  return value;
}
