import { createRoot } from "react-dom/client";
import { DiagnosticsWorkspace } from "../../src/DiagnosticsWorkspace";
import { DEFAULT_RETENTION, StatusSchema, DiagnosticEventSchema, type DiagnosticsApi, type DiagnosticEvent, type DiagnosticStatus } from "../../../src/diagnostics/contracts";
import type { Language } from "../../src/types";
import "../../src/tokens.css";
import "../../src/styles.css";

const fixture = (window as unknown as { fixture: { language: Language; eventCount?: number } }).fixture;
const events: DiagnosticEvent[] = Array.from({ length: fixture.eventCount ?? 110 }, (_, i) => ({ version: 1, id: `11111111-1111-4111-8111-${i.toString(16).padStart(12, "0")}`, time: Date.now(), kind: "span", name: `setup.stage.${i}`, body: `Synthetic stage ${i}`, taskName: i === 0 ? "A deliberately long supplied operation name with 日本語 中文 and detailed context" : undefined, severity: "info", component: "launcher", environment: "test", target: "fixture", traceId: "1".repeat(32), spanId: (i + 1).toString(16).padStart(16, "0"), attributes: {}, span: { startTime: 1, endTime: 2, outcome: "succeeded" } }));
const fixtureStatus: DiagnosticStatus = { version: 1, available: true, schemaVersion: 1, eventCount: 110, operationCount: 110, problemCount: 0, bytes: 8192, privateBytes: 0, dropped: 0, oldestTime: 1, newestTime: 2, captures: { debugUntil: 0, privateUntil: 0, privateScope: "" }, retention: DEFAULT_RETENTION, components: ["launcher"], targets: ["fixture"], notices: [] };
// Test-owned barriers model slow delivery; renderer/controller logic remains real.
const held = new Map<string, () => void>();
const control = { hold: false, started: 0, startedAt: 0, cancelled: 0,
  release() { control.hold = false; for (const resolve of held.values()) resolve(); held.clear(); },
  activity() { fixtureStatus.newestTime = (fixtureStatus.newestTime ?? 0) + 1; },
};
(window as unknown as { diagnosticsFixture: typeof control }).diagnosticsFixture = control;
const api: DiagnosticsApi = {
  status: async () => fixtureStatus,
  query: async (query, id) => { control.started++; control.startedAt = performance.now(); if (control.hold) await new Promise<void>(resolve => held.set(id!, resolve)); const offset = Number(query.cursor ?? 0); const limit = query.limit ?? 100; return { version: 1, events: events.slice(offset, offset + limit), nextCursor: offset + limit < events.length ? String(offset + limit) : undefined, incomplete: false, notices: [] }; },
  cancelQuery: async id => { control.cancelled++; held.get(id!)?.(); held.delete(id!); }, subscribe: () => () => {},
  capture: async command => { if (command.action === "debug-start") fixtureStatus.captures.debugUntil = Date.now() + DEFAULT_RETENTION.debugMs; return fixtureStatus.captures; },
  clear: async () => { fixtureStatus.eventCount = 0; return fixtureStatus; },
  export: async () => ({ cancelled: true }), copy: async () => {},
};
StatusSchema.parse(fixtureStatus);
events.forEach(event => DiagnosticEventSchema.parse(event));
createRoot(document.getElementById("root")!).render(<DiagnosticsWorkspace api={api} language={fixture.language} />);
