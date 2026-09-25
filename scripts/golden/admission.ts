import { z } from "zod";
import { nativeRateLimited, type NativeScenarioFailure } from "./structured-scenarios";
import type { DiagnosticEvent } from "../../src/diagnostics/contracts";
import { DiagnosticError } from "../../src/diagnostics/problems";

export const AdmissionObservationSchema = z.object({
  code: z.literal("rate_limit_exceeded"), reason: z.string().min(1).max(4096), evidence: z.string().min(1).max(4096),
  threadId: z.string().min(1).max(256), turnId: z.string().min(1).max(256),
}).strict();
export const AdmissionHoldSchema = AdmissionObservationSchema.extend({ id: z.string().uuid(), observedAt: z.number().int().positive() });
export type AdmissionObservation = z.infer<typeof AdmissionObservationSchema>;

export function nativeAdmissionObservation(failure: NativeScenarioFailure["nativeFailure"] | undefined, evidence: string): AdmissionObservation | undefined {
  const limited = failure?.turns.find(nativeRateLimited);
  if (!limited || !failure?.threadId) return undefined;
  return AdmissionObservationSchema.parse({ code: "rate_limit_exceeded", reason: "Native account rate limit; admission remains suspended until reviewed resumption. Incomplete evidence still requires reconciliation.", evidence, threadId: failure.threadId, turnId: limited.id });
}

/** Only an owned ChatGPT conversation POST's HTTP 429 can constrain admission without native rate evidence. */
export function diagnosticAdmissionObservation(events: readonly DiagnosticEvent[], ownedThreads: readonly string[], evidence: string): AdmissionObservation | undefined {
  const owners = new Map<string, Set<string>>();
  for (const event of events) if (event.kind === "span" && event.name === "http.responses" && event.traceId && event.taskId) {
    const known = owners.get(event.traceId) ?? new Set<string>(); known.add(event.taskId); owners.set(event.traceId, known);
  }
  for (const event of events) {
    if (event.kind !== "problem" || event.problem?.code !== "rate_limit_exceeded"
      || event.problem.origin !== "chatgpt-http" || event.problem.httpStatus !== 429 || !event.traceId) continue;
    const known = owners.get(event.traceId);
    if (known?.size !== 1) continue;
    const [threadId, turnId, extra] = [...known][0]!.split(":");
    if (extra !== undefined || !threadId || !turnId || !ownedThreads.includes(threadId) || !z.string().uuid().safeParse(threadId).success || !z.string().uuid().safeParse(turnId).success) continue;
    return AdmissionObservationSchema.parse({ code: "rate_limit_exceeded", reason: "A correlated native request reported an account rate limit; admission remains suspended until reviewed resumption. Content omissions do not remove this constraint.", evidence, threadId, turnId });
  }
}

/** An admission constraint does not establish settlement or authorize replay of its producer. */
export class GoldenAdmissionSuspended extends DiagnosticError {
  readonly observation: AdmissionObservation;
  constructor(observation: AdmissionObservation) {
    const parsed = AdmissionObservationSchema.parse(observation);
    super({ code: "rate_limit_exceeded", httpStatus: 429, message: parsed.reason, origin: "golden-admission", retryable: false, recovery: "unknown" }); this.name = "GoldenAdmissionSuspended"; this.observation = parsed;
  }
}
