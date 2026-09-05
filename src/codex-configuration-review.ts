import { configurationPathName, discoverConfigurationSource } from "./codex-config-occurrences";
import type { CodexRepairPreview, CodexConfigScalar, ConfigurationReviewGroup, ConfigurationReviewOccurrence, IntegrationTarget } from "./contracts/codex-integration";
import { join } from "node:path";
import { readJournal } from "./codex-integration-journal";
import { snapshotFile, type FileSnapshot } from "./codex-integration-shared";

export function configurationReviewContext(target: IntegrationTarget, inputs?: readonly FileSnapshot[]): { baseSource?: string; trackedPaths: string[] } {
  const trackedPaths: string[] = [];
  try {
    const journal = readJournal({ target, repair: false });
    if (journal && journal.configPath === target.configPath && journal.version === 10 && journal.active) {
      trackedPaths.push("openai_base_url", "experimental_realtime_webrtc_call_base_url");
      if (journal.installed.subagent_protocol === "compatibility-v1") trackedPaths.push("features.multi_agent", "features.multi_agent_v2", "features.multi_agent_v2.enabled", "agents.max_depth");
      const hook = journal.interruptHook;
      for (const key of ["command", "type", "timeout", "async"]) trackedPaths.push(configurationPathName(["hooks", "Interrupt", hook.groupIndex, "hooks", 0, key]));
      trackedPaths.push(configurationPathName(["hooks", "state", hook.stateKey, "trusted_hash"]));
    }
  } catch { /* Unreadable ownership is not evidence of ownership. */ }
  if (target.kind === "base") return { trackedPaths };
  const path = join(target.codexHome, "config.toml");
  const base = inputs?.find(input => input.path === path) ?? snapshotFile(path);
  return { trackedPaths, baseSource: base.data?.toString("utf8") ?? "" };
}

const relevant = (path: string) => ["openai_base_url", "experimental_realtime_webrtc_call_base_url", "model_provider", "model_catalog_json", "agents.max_depth"].includes(path)
  || path.startsWith("features.multi_agent") || path.startsWith("hooks.");
const scalar = (value: unknown): CodexConfigScalar | null => value === undefined ? null
  : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : JSON.stringify(value);
function groupFor(path: string): ConfigurationReviewGroup["id"] {
  if (["openai_base_url", "experimental_realtime_webrtc_call_base_url", "model_provider"].includes(path)) return "connection";
  if (path.startsWith("features.multi_agent") || path === "agents.max_depth" || path.includes("subagentProtocol") || path.includes("subagent_protocol")) return "subagents";
  if (path.startsWith("hooks.")) return "interrupt";
  if (path === "model_catalog_json") return "catalog";
  if (path.startsWith("runtime.")) return "runtime";
  return "other";
}

/** Present backend evidence, never choose a winner for invalid same-layer definitions. */
export function withConfigurationReview(preview: CodexRepairPreview, target: IntegrationTarget, source: string, options: { baseSource?: string; proposedBaseSource?: string; trackedPaths?: readonly string[] } = {}): CodexRepairPreview {
  const layers = [
    ...(options.baseSource === undefined ? [] : [{ text: options.baseSource, file: `${target.codexHome}/config.toml`, layer: "base" as const }]),
    { text: source, file: target.configPath, layer: target.kind },
  ];
  const discovered = layers.map(layer => ({ ...layer, source: discoverConfigurationSource(layer.text) }));
  const proposedBase = options.proposedBaseSource === undefined ? undefined : discoverConfigurationSource(options.proposedBaseSource);
  const paths = new Set([...preview.changes.map(change => change.path), ...preview.conflicts.map(conflict => conflict.path)]);
  for (const layer of discovered) for (const item of layer.source.occurrences) {
    const path = configurationPathName(item.path);
    if (item.kind === "assignment" && relevant(path)) paths.add(target.kind === "profile" && layer.layer === "base" && path.startsWith("hooks.") ? `inherited:${path}` : path);
    if (layer.file === target.configPath && item.kind === "route-section" && layer.source.occurrences.filter(candidate => candidate.kind === "route-section").length > 1) paths.add("section:managed_sections.routes");
    if (layer.file === target.configPath && item.kind === "table" && !item.path.some(part => typeof part === "number")
      && ["features", "agents", "hooks"].includes(String(item.path[0]))
      && layer.source.occurrences.filter(candidate => candidate.kind === "table" && configurationPathName(candidate.path) === path).length > 1) paths.add(`table:${path}`);
  }
  const groups = new Map<ConfigurationReviewGroup["id"], ConfigurationReviewGroup>();
  for (const identity of paths) {
    const inheritedHook = identity.startsWith("inherited:");
    const tableChoice = identity.startsWith("table:");
    const sectionChoice = identity.startsWith("section:");
    const path = inheritedHook ? identity.slice("inherited:".length) : tableChoice ? identity.slice("table:".length) : sectionChoice ? identity.slice("section:".length) : identity;
    const occurrences: ConfigurationReviewOccurrence[] = [];
    for (const layer of discovered) for (const item of layer.source.occurrences) {
      if (item.kind !== (tableChoice ? "table" : sectionChoice ? "route-section" : "assignment") || configurationPathName(item.path) !== path) continue;
      if ((tableChoice || sectionChoice) && layer.file !== target.configPath) continue;
      if (target.kind === "profile" && path.startsWith("hooks.") && (inheritedHook ? layer.layer !== "base" : layer.layer === "base")) continue;
      occurrences.push({ id: item.id, file: layer.file, layer: layer.layer, line: item.line, endLine: item.endLine,
        value: tableChoice ? `[${path}]` : sectionChoice ? "Bounded route section" : scalar(item.value), state: item.state,
        ownership: layer.file === target.configPath && options.trackedPaths?.includes(path) ? "tracked" : "unclaimed" });
    }
    const active = occurrences.filter(item => item.state === "active");
    const localActive = active.filter(item => item.file === target.configPath);
    const winners = localActive.length ? localActive : active;
    const ambiguous = discovered.some(layer => !layer.source.complete) || layers.some(layer => active.filter(item => item.file === layer.file).length > 1);
    const change = inheritedHook || tableChoice ? undefined : preview.changes.find(item => item.path === path);
    const findings = inheritedHook || tableChoice ? [] : preview.conflicts.filter(item => item.path === path);
    const current = ambiguous ? null : winners.length === 1 ? winners[0]!.value : change?.current ?? null;
    const groupId = sectionChoice ? "connection" : tableChoice && ["features", "agents"].includes(path.split(".")[0]!) ? "subagents" : groupFor(path);
    let group = groups.get(groupId);
    if (!group) { group = { id: groupId, settings: [] }; groups.set(groupId, group); }
    const localOccurrences = occurrences.filter(item => item.file === target.configPath);
    const inheritedProposed = proposedBase && !localActive.length ? proposedBase.occurrences.filter(item => item.kind === "assignment" && item.state === "active" && configurationPathName(item.path) === path) : undefined;
    group.settings.push({ path: identity, current, proposed: change ? change.proposed : inheritedProposed ? inheritedProposed.length === 1 ? scalar(inheritedProposed[0]!.value) : null : current,
      state: ambiguous ? "ambiguous" : active.length ? "active" : occurrences.length ? "commented_out" : change?.currentState ?? "missing",
      inherited: !localActive.length && winners.some(item => item.file !== target.configPath), occurrences, findings,
      ...(findings.find(item => item.expected !== undefined)?.expected !== undefined ? { baseline: findings.find(item => item.expected !== undefined)!.expected } : {}),
      resolutionRequired: !inheritedHook && (localActive.length > 1 || (!localActive.length && localOccurrences.length > 1)),
      ...(tableChoice ? { resolutionKind: "table" as const } : {}),
      ...(sectionChoice ? { resolutionKind: "route-section" as const } : {}),
    });
  }
  const order: ConfigurationReviewGroup["id"][] = ["connection", "subagents", "interrupt", "catalog", "runtime", "other"];
  return { ...preview, version: 2, target, groups: order.flatMap(id => groups.has(id) ? [groups.get(id)!] : []) };
}
