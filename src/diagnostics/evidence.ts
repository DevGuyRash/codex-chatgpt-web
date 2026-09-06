import type { DiagnosticEvent } from "./contracts";

export function canonicalStages(events: readonly DiagnosticEvent[]): DiagnosticEvent[] {
  const spans = new Map<string, DiagnosticEvent>();
  for (const event of events) {
    if (!event.span || !event.spanId || !event.traceId) continue;
    const key = `${event.traceId}:${event.spanId}`;
    const prior = spans.get(key);
    if (!prior || prior.span?.outcome === "running" && event.span.outcome !== "running"
      || prior.span?.outcome === event.span.outcome && event.time > prior.time) spans.set(key, event);
  }
  return [...spans.values()].sort((a, b) => a.span!.startTime - b.span!.startTime || a.spanId!.localeCompare(b.spanId!));
}

export function stageHierarchy(events: readonly DiagnosticEvent[]) {
  const stages = canonicalStages(events);
  const byId = new Map(stages.map(stage => [`${stage.traceId}:${stage.spanId}`, stage]));
  return stages.map(event => {
    let parent = event.parentSpanId, depth = 0, missingParent = false, cycle = false;
    const seen = new Set([event.spanId]);
    while (parent) {
      if (seen.has(parent)) { cycle = true; break; }
      seen.add(parent);
      const found = byId.get(`${event.traceId}:${parent}`);
      if (!found) { missingParent = true; break; }
      depth++; parent = found.parentSpanId;
    }
    return { event, depth, missingParent, cycle, parentName: byId.get(`${event.traceId}:${event.parentSpanId}`)?.name };
  });
}

export function hasOutcomeConflict(event: DiagnosticEvent | undefined, events: readonly DiagnosticEvent[]): boolean {
  if (!event?.traceId) return false;
  const stages = canonicalStages(events);
  return events.some(problem => problem.kind === "problem" && problem.traceId === event.traceId
    && stages.some(stage => stage.spanId === problem.spanId && stage.span?.outcome === "cancelled"));
}
