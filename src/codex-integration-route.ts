import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectInstalledCodexConfig } from "./codex-integration-inspection";
import { parseTomlValue, removeTomlComments, setTomlScalar } from "./toml-edit";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  MANAGED_COMMENT,
  MANAGED_ROUTE_COMMENT,
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
  managedAgentMaxDepthLine,
} from "./codex-integration-shared";
import type {
  CodexIntegrationJournal,
  LegacyCodexIntegrationJournal,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  ManagedAssignmentKey,
  ManagedRouteJournal,
  PreviousAssignment,
  PreviousFeatureAssignment,
  PreviousAgentAssignment,
} from "./codex-integration-shared";
import {
  restoreCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "./codex-interrupt-hook";
import {
  assignments,
  findFeatureAssignment,
  findAgentMaxDepthAssignment,
  findMultiAgentV2Assignment,
  findTopLevelAssignment,
  firstTableIndex,
  insertDocumentLine,
  managedMultiAgentV2AssignmentLine,
  parseDocument,
  removeDocumentLine,
  removeManagedComment,
  renderDocument,
  restoreBooleanFeature,
  restoreCompatibilityV1Features,
  restoreCompatibilityV1AgentDepth,
  restoreManagedFeatures,
  restoreMultiAgentV2Feature,
  splitLines,
  verifyInstalledFeatures,
} from "./codex-integration-document";

function compatibilityV1Evidence(
  journal: CodexIntegrationJournal | LegacyCodexIntegrationJournalV9 | LegacyCodexIntegrationJournalV8,
): {
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  previousAgentMaxDepth: PreviousAgentAssignment;
  installedAgentMaxDepth: number;
} | undefined {
  if (journal.installed.subagent_protocol !== "compatibility-v1") return undefined;
  if (!journal.previousMultiAgent || !journal.previousMultiAgentV2
    || !journal.previousAgentMaxDepth || journal.installed.agent_max_depth === undefined) {
    throw new Error("Codex integration journal is missing the Compatibility V1 feature baseline");
  }
  return {
    previousMultiAgent: journal.previousMultiAgent,
    previousMultiAgentV2: journal.previousMultiAgentV2,
    previousAgentMaxDepth: journal.previousAgentMaxDepth,
    installedAgentMaxDepth: journal.installed.agent_max_depth,
  };
}

function restoreOwnedManagedFeatures(text: string, journal: ManagedRouteJournal): string {
  let restored = text;
  if (journal.version === 8 || journal.version === 9 || journal.version === 10) {
    const evidence = compatibilityV1Evidence(journal);
    if (evidence) {
      const depth = findAgentMaxDepthAssignment(splitLines(restored));
      if (depth.rawLine === managedAgentMaxDepthLine(evidence.installedAgentMaxDepth)
        && depth.value === String(evidence.installedAgentMaxDepth)) {
        restored = restoreCompatibilityV1AgentDepth(
          restored,
          evidence.previousAgentMaxDepth,
          evidence.installedAgentMaxDepth,
        );
      }
      const multiAgentV2 = findMultiAgentV2Assignment(splitLines(restored));
      const managedV2Line = managedMultiAgentV2AssignmentLine(evidence.previousMultiAgentV2);
      if (multiAgentV2.rawLine === managedV2Line && multiAgentV2.value === "false") {
        restored = restoreMultiAgentV2Feature(restored, evidence.previousMultiAgentV2);
      }
      const multiAgent = findFeatureAssignment(splitLines(restored), "multi_agent");
      if (multiAgent.rawLine === MANAGED_MULTI_AGENT_LINE && multiAgent.value === "true") {
        restored = restoreBooleanFeature(
          restored,
          "multi_agent",
          "true",
          MANAGED_MULTI_AGENT_LINE,
          evidence.previousMultiAgent,
        );
      }
    }
  }
  if (journal.version === 6) {
    const current = findMultiAgentV2Assignment(splitLines(restored));
    const managedLine = managedMultiAgentV2AssignmentLine(journal.previousMultiAgentV2);
    if (current.rawLine === managedLine && current.value === "false") {
      restored = restoreMultiAgentV2Feature(restored, journal.previousMultiAgentV2);
    }
  }
  if (journal.version === 5 || journal.version === 6) {
    const multiAgent = findFeatureAssignment(splitLines(restored), "multi_agent");
    if (multiAgent.rawLine === MANAGED_MULTI_AGENT_LINE && multiAgent.value === "true") {
      restored = restoreBooleanFeature(
        restored,
        "multi_agent",
        "true",
        MANAGED_MULTI_AGENT_LINE,
        journal.previousMultiAgent,
      );
    }
    const compaction = findFeatureAssignment(splitLines(restored), "remote_compaction_v2");
    if (compaction.rawLine === MANAGED_REMOTE_COMPACTION_LINE && compaction.value === "false") {
      restored = restoreBooleanFeature(
        restored,
        "remote_compaction_v2",
        "false",
        MANAGED_REMOTE_COMPACTION_LINE,
        journal.previousRemoteCompactionV2,
      );
    }
  }
  return restored;
}
function restoreStillManagedRouteAssignments(text: string, journal: ManagedRouteJournal): string {
  const document = parseDocument(text);
  removeManagedComment(document);
  const current = assignments(document.lines);
  const target = Object.fromEntries(
    (Object.keys(current) as ManagedAssignmentKey[]).map(key => {
      const stillManaged = key === "openai_base_url"
        ? current[key].present && current[key].value === journal.installed.openai_base_url
        : !current[key].present;
      return [key, stillManaged ? journal.previous[key] : current[key]];
    }),
  ) as Record<ManagedAssignmentKey, PreviousAssignment>;
  const currentIndices = Object.values(current)
    .flatMap(assignment => assignment.index === undefined ? [] : [assignment.index])
    .sort((left, right) => right - left);
  for (const index of currentIndices) removeDocumentLine(document, index);

  const previous = (Object.entries(target) as Array<[ManagedAssignmentKey, PreviousAssignment]>)
    .filter(([, assignment]) => assignment.present)
    .sort(([, left], [, right]) => (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER));
  for (const [key, assignment] of previous) {
    if (!assignment.rawLine) throw new Error(`Codex integration journal is missing the prior ${key} line`);
    const index = Math.min(assignment.index ?? firstTableIndex(document.lines), firstTableIndex(document.lines));
    insertDocumentLine(document, index, assignment.rawLine);
  }
  return renderDocument(document);
}
export function managedJournalIsActive(journal: ManagedRouteJournal): boolean {
  return journal.version === 3 || journal.active;
}

export function verifyManagedJournalState(text: string, journal: ManagedRouteJournal): void {
  if (journal.version === 3 || journal.active) verifyInstalledRoute(text, journal);
  else verifyRestoredRoute(text, journal);
}

export function replacementBaseline(
  currentText: string,
  configExists: boolean,
  journal: ManagedRouteJournal,
): string {
  if (!configExists) return "";
  if (!managedJournalIsActive(journal)) return currentText;

  if (journal.version === 9 || journal.version === 10) {
    const withoutHook = journal.version === 10
      ? restoreCodexInterruptHook(currentText, journal.interruptHook)
      : currentText;
    const baseline = restoreOwnedManagedFeatures(withoutHook, journal);
    const document = parseDocument(baseline);
    removeManagedComment(document);
    for (const [key, installedValue, previous] of [
      ["openai_base_url", journal.installed.openai_base_url, journal.previous.openai_base_url],
      [
        "experimental_realtime_webrtc_call_base_url",
        journal.installed.experimental_realtime_webrtc_call_base_url,
        journal.previousRealtimeWebrtcCallBaseUrl,
      ],
    ] as const) {
      const current = findTopLevelAssignment(document.lines, key);
      if (current.value !== installedValue || current.index === undefined) continue;
      if (previous.present) {
        if (!previous.rawLine) throw new Error(`Codex integration journal is missing the prior ${key} line`);
        document.lines[current.index] = previous.rawLine;
      } else {
        removeDocumentLine(document, current.index);
      }
    }
    return renderDocument(document);
  }

  if (journal.version === 7 || journal.version === 8) {
    const baseline = restoreOwnedManagedFeatures(currentText, journal);
    const document = parseDocument(baseline);
    removeManagedComment(document);
    const current = findTopLevelAssignment(document.lines, "openai_base_url");
    if (current.value === journal.installed.openai_base_url && current.index !== undefined) {
      const previous = journal.previous.openai_base_url;
      if (previous.present) {
        if (!previous.rawLine) throw new Error("Codex integration journal is missing the prior openai_base_url line");
        document.lines[current.index] = previous.rawLine;
      } else {
        removeDocumentLine(document, current.index);
      }
    }
    return renderDocument(document);
  }

  let baseline = restoreOwnedManagedFeatures(currentText, journal);
  baseline = restoreStillManagedRouteAssignments(baseline, journal);
  return baseline;
}

export function installRoute(
  text: string,
  installedUrl: string,
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
} {
  const parsed = parsedConfig(text);
  const capture = (key: string): PreviousAssignment => {
    const value = parsed[key];
    if (value === undefined) return { present: false };
    if (typeof value !== "string") throw new Error(`Codex ${key} must be a string before route ownership can be acquired`);
    const legacy = findTopLevelAssignment(splitLines(text), key);
    return legacy.present && legacy.value === value ? legacy : { present: true, value, rawLine: `${key} = ${JSON.stringify(value)}` };
  };
  const previous = {
    openai_base_url: capture("openai_base_url"), model_provider: capture("model_provider"), model_catalog_json: capture("model_catalog_json"),
  };
  const previousRealtimeWebrtcCallBaseUrl = capture("experimental_realtime_webrtc_call_base_url");
  if (previous.openai_base_url.present && !replaceExistingRoute) throw new Error("Codex already configures model routing. Rerun with --replace-codex-route to replace it reversibly. Check whether another Codex extension or wrapper (for example, OpenCodex or Headroom) is replacing the bridge port.");
  if (previousRealtimeWebrtcCallBaseUrl.present && previousRealtimeWebrtcCallBaseUrl.value !== CODEX_REALTIME_WEBRTC_CALL_BASE_URL && !replaceExistingRealtimeRoute) throw new Error("Codex already configures its realtime WebRTC call route. Rerun with --replace-codex-route to replace it reversibly.");
  let result = setTomlScalar(text, ["openai_base_url"], installedUrl);
  result = setTomlScalar(result, ["experimental_realtime_webrtc_call_base_url"], CODEX_REALTIME_WEBRTC_CALL_BASE_URL);
  result = removeTomlComments(result, [MANAGED_COMMENT, MANAGED_ROUTE_COMMENT]);
  // Retain the historical layout only as a rendering optimization, not a parser
  // or authority decision. Quoted keys and inline syntax use the semantic result.
  try {
    const legacy = installLegacyRouteLayout(text, installedUrl);
    if (isDeepStrictEqual(parsedConfig(legacy), parsedConfig(result))) result = legacy;
  } catch { /* The verified syntax-aware edit is sufficient. */ }
  return { text: result, previous, previousRealtimeWebrtcCallBaseUrl };
}

function installLegacyRouteLayout(
  text: string,
  installedUrl: string,
): string {
  const document = parseDocument(text);

  const currentBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  if (currentBaseUrl.index !== undefined) {
    document.lines[currentBaseUrl.index] = `openai_base_url = ${JSON.stringify(installedUrl)}`;
  } else {
    insertDocumentLine(document, firstTableIndex(document.lines), `openai_base_url = ${JSON.stringify(installedUrl)}`);
  }
  const currentRealtimeUrl = findTopLevelAssignment(document.lines, "experimental_realtime_webrtc_call_base_url");
  const realtimeLine = `experimental_realtime_webrtc_call_base_url = ${JSON.stringify(CODEX_REALTIME_WEBRTC_CALL_BASE_URL)}`;
  if (currentRealtimeUrl.index !== undefined) {
    document.lines[currentRealtimeUrl.index] = realtimeLine;
  } else {
    const installedBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
    insertDocumentLine(document, installedBaseUrl.index! + 1, realtimeLine);
  }
  removeManagedComment(document);
  const installedBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  insertDocumentLine(document, installedBaseUrl.index!, MANAGED_ROUTE_COMMENT);
  return renderDocument(document);
}

export function verifyInstalledRoute(text: string, journal: ManagedRouteJournal): void {
  if (journal.version === 8 || journal.version === 9 || journal.version === 10) {
    const conflicts = inspectInstalledCodexConfig(text, journal);
    if (conflicts.length) throw new Error(conflicts.map(conflict => conflict.message).join("; "));
    return;
  }
  const lines = splitLines(text);
  const current = assignments(lines);
  if (current.openai_base_url.value !== journal.installed.openai_base_url) {
    throw new Error("Codex openai_base_url changed after setup; refusing to overwrite the user's newer value");
  }
  if (!lines.includes(MANAGED_COMMENT)) {
    throw new Error("Managed Codex route marker changed after setup; refusing to overwrite it");
  }
  if (journal.version !== 7) {
    if (current.model_provider.present || current.model_catalog_json.present) {
      throw new Error("Codex model_provider or model_catalog_json changed after setup; refusing to overwrite the user's newer value");
    }
    if (journal.version === 5 || journal.version === 6) verifyInstalledFeatures(text, journal);
  }
}

function previousAssignmentMatches(current: PreviousAssignment, previous: PreviousAssignment): boolean {
  return current.present === previous.present
    && (!current.present || current.value === previous.value);
}

export function verifyRestoredRoute(
  text: string,
  journal: CodexIntegrationJournal | LegacyCodexIntegrationJournalV9 | LegacyCodexIntegrationJournalV8 | LegacyCodexIntegrationJournalV7 | LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5 | LegacyCodexIntegrationJournalV4,
): void {
  if (journal.version === 8 || journal.version === 9 || journal.version === 10) {
    verifySemanticRestoredRoute(text, journal);
    return;
  }
  const lines = splitLines(text);
  const current = assignments(lines);
  const keys = journal.version === 7
    ? (["openai_base_url"] as const)
    : (["openai_base_url", "model_provider", "model_catalog_json"] as const);
  for (const key of keys) {
    if (!previousAssignmentMatches(current[key], journal.previous[key])) {
      throw new Error(`Codex ${key} changed while the bridge was disconnected; refusing to overwrite the user's newer value`);
    }
  }
  if (lines.includes(MANAGED_COMMENT) || lines.includes(MANAGED_ROUTE_COMMENT)) {
    throw new Error("Managed Codex route marker is present while the bridge is disconnected");
  }
  if (journal.version === 5 || journal.version === 6) {
    const previousFeatures: Array<readonly [string, PreviousFeatureAssignment]> = [
      ["remote_compaction_v2", journal.previousRemoteCompactionV2],
      ["multi_agent", journal.previousMultiAgent],
    ];
    if (journal.version === 6) {
      previousFeatures.push(["multi_agent_v2", journal.previousMultiAgentV2]);
    }
    for (const [key, previous] of previousFeatures) {
      const current = key === "multi_agent_v2"
        ? findMultiAgentV2Assignment(lines)
        : findFeatureAssignment(lines, key);
      const matches = current.present === previous.present
        && (current.tableName ?? "features") === (previous.tableName ?? "features")
        && (!current.present || current.rawLine === previous.rawLine);
      if (!matches) {
        throw new Error(
          `Codex [features].${key} changed while the bridge was disconnected; refusing to overwrite the user's newer value`,
        );
      }
    }
  }
}

export function assertPreservedPreviousAssignments(
  actual: CodexIntegrationJournal["previous"],
  expected: CodexIntegrationJournal["previous"],
): void {
  if (!previousAssignmentMatches(actual.openai_base_url, expected.openai_base_url)) {
    throw new Error("Codex openai_base_url changed while the bridge was disconnected; refusing to replace it");
  }
}

export function assertPreservedPreviousRealtimeAssignment(
  actual: PreviousAssignment,
  expected: PreviousAssignment,
): void {
  if (!previousAssignmentMatches(actual, expected)) {
    throw new Error("Codex realtime WebRTC call route changed while the bridge was disconnected; refusing to replace it");
  }
}

export function restoreManagedRoute(text: string, journal: ManagedRouteJournal): string {
  verifyInstalledRoute(text, journal);
  if (journal.version === 8 || journal.version === 9 || journal.version === 10) {
    const semantic = restoreSemanticRoute(text, journal);
    // Preserve historical byte-for-byte restoration where its result agrees with
    // the semantic edit. Legacy rendering is never ownership evidence.
    try {
      const legacy = restoreLegacyRouteLayout(text, journal);
      const normalize = (source: string) => {
        const value = parseTomlValue(source) as Record<string, unknown>;
        for (const [key, owned] of [["features", journal.previousMultiAgent?.tablePresent === false], ["agents", journal.previousAgentMaxDepth?.tablePresent === false]] as const) {
          const branch = value[key];
          if (owned && branch && typeof branch === "object" && !Object.keys(branch).length) delete value[key];
        }
        return value;
      };
      if (isDeepStrictEqual(normalize(legacy), normalize(semantic))) return legacy;
    } catch { /* Syntax-aware restoration remains authoritative. */ }
    return semantic;
  }
  return restoreLegacyRouteLayout(text, journal);
}

type ModernRouteJournal = Extract<ManagedRouteJournal, { version: 8 | 9 | 10 }>;
function parsedConfig(text: string): Record<string, unknown> {
  try { return parseTomlValue(text) as Record<string, unknown>; }
  catch { throw new Error("Codex configuration is not valid, unambiguous TOML; inspect it before changing integration"); }
}
function configValue(document: unknown, path: readonly string[]): unknown {
  for (const key of path) document = document && typeof document === "object" && Object.hasOwn(document, key)
    ? (document as Record<string, unknown>)[key] : undefined;
  return document;
}
function restoredValues(text: string, journal: ModernRouteJournal): Array<[string[], string | number | boolean | undefined]> {
  const document = parsedConfig(text);
  const values: Array<[string[], string | number | boolean | undefined]> = [
    [["openai_base_url"], journal.previous.openai_base_url.present ? journal.previous.openai_base_url.value : undefined],
  ];
  if (journal.version === 9 || journal.version === 10) values.push([
    ["experimental_realtime_webrtc_call_base_url"], journal.previousRealtimeWebrtcCallBaseUrl.present ? journal.previousRealtimeWebrtcCallBaseUrl.value : undefined,
  ]);
  const evidence = compatibilityV1Evidence(journal);
  if (evidence) {
    const v2 = configValue(document, ["features", "multi_agent_v2"]);
    const v2Path = v2 && typeof v2 === "object" ? ["features", "multi_agent_v2", "enabled"] : ["features", "multi_agent_v2"];
    for (const [path, previous] of [
      [["features", "multi_agent"], evidence.previousMultiAgent], [v2Path, evidence.previousMultiAgentV2],
    ] as const) values.push([[...path], previous.present && previous.value !== "unset" ? previous.value === "true" : undefined]);
    values.push([["agents", "max_depth"], evidence.previousAgentMaxDepth.present ? Number(evidence.previousAgentMaxDepth.value) : undefined]);
  }
  return values;
}
function verifySemanticRestoredRoute(text: string, journal: ModernRouteJournal): void {
  const document = parsedConfig(text);
  const conflicts = restoredValues(text, journal).filter(([path, value]) => configValue(document, path) !== value);
  if (conflicts.length) throw new Error(conflicts.map(([path]) => `Codex ${path.join(".")} changed while the bridge was disconnected; review the newer value before reconnecting`).join("; "));
  if (journal.version === 10) verifyCodexInterruptHookRestored(text, journal.interruptHook);
}
function restoreSemanticRoute(text: string, journal: ModernRouteJournal): string {
  let result = journal.version === 10 ? restoreCodexInterruptHook(text, journal.interruptHook) : text;
  for (const [path, value] of restoredValues(result, journal)) result = setTomlScalar(result, path, value);
  result = removeTomlComments(result, [MANAGED_COMMENT, MANAGED_ROUTE_COMMENT]);
  verifySemanticRestoredRoute(result, journal);
  return result;
}

function restoreLegacyRouteLayout(text: string, journal: ManagedRouteJournal): string {
  const withoutHook = journal.version === 10
    ? restoreCodexInterruptHook(text, journal.interruptHook)
    : text;
  const document = parseDocument(withoutHook);
  removeManagedComment(document);
  const currentBaseUrl = findTopLevelAssignment(document.lines, "openai_base_url");
  if (currentBaseUrl.index === undefined) throw new Error("Managed Codex openai_base_url is missing");
  const previousBaseUrl = journal.previous.openai_base_url;
  if (previousBaseUrl.present) {
    if (!previousBaseUrl.rawLine) throw new Error("Codex integration journal is missing the prior openai_base_url line");
    document.lines[currentBaseUrl.index] = previousBaseUrl.rawLine;
  } else {
    removeDocumentLine(document, currentBaseUrl.index);
  }
  if (journal.version === 9 || journal.version === 10) {
    const currentRealtime = findTopLevelAssignment(document.lines, "experimental_realtime_webrtc_call_base_url");
    if (currentRealtime.index === undefined) throw new Error("Managed Codex realtime WebRTC call route is missing");
    const previousRealtime = journal.previousRealtimeWebrtcCallBaseUrl;
    if (previousRealtime.present) {
      if (!previousRealtime.rawLine) {
        throw new Error("Codex integration journal is missing the prior realtime WebRTC call route line");
      }
      document.lines[currentRealtime.index] = previousRealtime.rawLine;
    } else {
      removeDocumentLine(document, currentRealtime.index);
    }
  }
  if (journal.version !== 7 && journal.version !== 8 && journal.version !== 9 && journal.version !== 10) {
    const removedAssignments = (["model_provider", "model_catalog_json"] as const)
      .map(key => ({ key, previous: journal.previous[key] }))
      .filter(item => item.previous.present)
      .sort((left, right) => (left.previous.index ?? Number.MAX_SAFE_INTEGER) - (right.previous.index ?? Number.MAX_SAFE_INTEGER));
    for (const item of removedAssignments) {
      if (!item.previous.rawLine) throw new Error(`Codex integration journal is missing the prior ${item.key} line`);
      const index = Math.min(item.previous.index ?? firstTableIndex(document.lines), firstTableIndex(document.lines));
      insertDocumentLine(document, index, item.previous.rawLine);
    }
  }
  const restoredRoute = renderDocument(document);
  if (journal.version === 8 || journal.version === 9 || journal.version === 10) {
    const evidence = compatibilityV1Evidence(journal);
    return evidence
      ? restoreCompatibilityV1Features(
          restoredRoute,
          evidence.previousMultiAgent,
          evidence.previousMultiAgentV2,
          evidence.previousAgentMaxDepth,
          evidence.installedAgentMaxDepth,
        )
      : restoredRoute;
  }
  return journal.version === 5 || journal.version === 6
    ? restoreManagedFeatures(restoredRoute, journal)
    : restoredRoute;
}

export function restoreLegacyV2(text: string, journal: LegacyCodexIntegrationJournal): string {
  if (!text.includes(journal.providerBlock)) {
    throw new Error("Managed legacy Codex provider block changed after setup; refusing migration");
  }
  const withoutProvider = text.replace(journal.providerBlock, "").replace(/\n{3,}/g, "\n\n");
  const document = parseDocument(withoutProvider);
  for (const key of ["model_provider", "model_catalog_json"] as const) {
    const current = findTopLevelAssignment(document.lines, key);
    if (current.value !== journal.installed[key] || current.index === undefined) {
      throw new Error(`Managed legacy Codex ${key} changed after setup; refusing migration`);
    }
    const previous = journal.previous[key];
    if (previous.present) {
      if (!previous.rawLine) throw new Error(`Legacy Codex integration journal is missing the prior ${key} line`);
      document.lines[current.index] = previous.rawLine;
    } else {
      removeDocumentLine(document, current.index);
    }
  }
  removeManagedComment(document);
  const restoredCatalog = findTopLevelAssignment(document.lines, "model_catalog_json");
  if (restoredCatalog.index !== undefined && restoredCatalog.value && !existsSync(resolve(restoredCatalog.value))) {
    removeDocumentLine(document, restoredCatalog.index);
  }
  return renderDocument(document);
}
