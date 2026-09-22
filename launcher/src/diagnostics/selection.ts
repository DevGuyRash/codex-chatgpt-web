export function selectDiagnosticRow(current: ReadonlySet<string>, orderedIds: readonly string[], id: string, anchor: string | undefined, modifiers: { shift: boolean; additive: boolean }) {
  const next = modifiers.additive ? new Set(current) : new Set<string>();
  const start = anchor ? orderedIds.indexOf(anchor) : -1, end = orderedIds.indexOf(id);
  if (modifiers.shift && start >= 0 && end >= 0) {
    for (const value of orderedIds.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(value);
  } else if (modifiers.additive && next.has(id)) next.delete(id);
  else next.add(id);
  return { selected: next, anchor: modifiers.shift && start >= 0 ? anchor : id };
}

export function visibleStageIds(stages: readonly { spanId?: string; parentSpanId?: string }[], collapsed: ReadonlySet<string>): Set<string> {
  const parents = new Map(stages.map(stage => [stage.spanId, stage.parentSpanId]));
  return new Set(stages.filter(stage => {
    const visited = new Set<string>();
    let parent = stage.parentSpanId;
    while (parent && !visited.has(parent)) {
      if (collapsed.has(parent)) return false;
      visited.add(parent); parent = parents.get(parent);
    }
    return true;
  }).flatMap(stage => stage.spanId ? [stage.spanId] : []));
}
