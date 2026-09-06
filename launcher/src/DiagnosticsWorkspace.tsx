import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CaptureCommand, DiagnosticEvent, DiagnosticsApi } from "../../src/diagnostics/contracts";
import { hasOutcomeConflict, stageHierarchy } from "../../src/diagnostics/evidence";
import { RecoveryActions } from "./Recovery";
import type { Language } from "./types";
import { diagnosticsCopy } from "./diagnostics/copy";
import { reportCopy, ReportMenus } from "./diagnostics/ReportMenus";
import { useDiagnostics } from "./diagnostics/use-diagnostics";
import { launcherActions } from "./actions/controller";
import { diagnosticErrors } from "./diagnostics/errors";
import "./diagnostics/styles.css";

const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
const duration = (event: DiagnosticEvent) => event.span?.endTime !== undefined ? `${Math.max(0, event.span.endTime - event.span.startTime).toFixed(0)} ms` : "—";
const title = (event: DiagnosticEvent) => event.taskName ?? event.name.replace(/^launcher:/, "").replace(/[._]/g, " ");

export function DiagnosticsWorkspace({ api, language, initialTrace, captureRequest }: { api: DiagnosticsApi; language: Language; initialTrace?: string; captureRequest?: number }) {
  const copy = diagnosticsCopy[language], labels = reportCopy[language];
  const { controller, state } = useDiagnostics(api);
  const { tab, status, result, filters, trace, selection } = state;
  const detail = controller.selected(), traceId = selection?.traceId;
  const query = state.filterError ? {} : controller.query();
  const stages = stageHierarchy(trace.events);
  const debugActive = (status?.captures.debugUntil ?? 0) > state.now, privateActive = (status?.captures.privateUntil ?? 0) > state.now;
  const [acknowledged, setAcknowledged] = useState(false);
  const [captureScope, setCaptureScope] = useState("next-browser-turn");
  const [confirmClear, setConfirmClear] = useState<"normal" | "private">();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const clearDialog = useRef<HTMLDialogElement>(null), inspector = useRef<HTMLElement>(null), lastRecord = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { controller.activate(true); return () => controller.activate(false); }, [controller]);
  useEffect(() => { if (captureRequest) controller.setTab("capture"); else if (initialTrace) { controller.openTrace(initialTrace); setCaptureScope(initialTrace); } }, [controller, initialTrace, captureRequest]);
  useEffect(() => { if (confirmClear) clearDialog.current?.showModal(); else clearDialog.current?.close(); }, [confirmClear]);
  const open = (event: DiagnosticEvent, trigger: HTMLButtonElement) => { lastRecord.current = trigger; controller.open(event); if (event.traceId) setCaptureScope(event.traceId); requestAnimationFrame(() => inspector.current?.focus({ preventScroll: true })); };
  const back = () => { controller.closeSelection(); requestAnimationFrame(() => lastRecord.current?.focus({ preventScroll: true })); };
  const refresh = () => void launcherActions.run("refresh", () => controller.refresh());
  const capture = (command: CaptureCommand) => void launcherActions.run("capture", async () => { await api.capture(command); setAcknowledged(false); await controller.observe(); });
  const stateLabel = (value: string) => ({ failed: copy.failedOutcome, succeeded: copy.succeeded, running: copy.lastObservedRunning, cancelled: copy.cancelled, interrupted: copy.interrupted, recovered: copy.recovered, unknown: copy.unknown, debug: copy.debugLevel, info: copy.info, warning: copy.warning, error: copy.error }[value] ?? value);
  const recoveryLabel = (value: string) => ({ "not-needed": copy.notNeeded, "not-started": copy.notStarted, completed: copy.completed, incomplete: copy.recoveryIncomplete, unknown: copy.unknown }[value] ?? value);
  const record = (event: DiagnosticEvent) => <button type="button" className="diagnostic-record" onClick={click => open(event, click.currentTarget)} key={event.id} aria-pressed={detail?.id === event.id}>
    <span className="diagnostic-record-heading"><strong>{title(event)}</strong><span className="diagnostic-status" data-outcome={event.span?.outcome ?? event.severity}>{stateLabel(event.span?.outcome ?? event.severity)}</span></span>
    <span className="diagnostic-record-body">{event.body}</span><small>{new Date(event.time).toLocaleString(language)} · {event.component} · {duration(event)}</small>
  </button>;

  return <section className="diagnostics-workspace" aria-label={copy.title} onScroll={event => controller.setInspecting(event.currentTarget.scrollTop > 100)}>
    <header className="diagnostics-heading"><div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div><div className="diagnostics-tools"><button type="button" onClick={refresh}>{copy.refresh}</button><ReportMenus api={api} language={language} query={query} eventId={detail?.id} traceId={traceId} invalid={state.filterError} /></div></header>
    {privateActive ? <p className="diagnostic-capture-banner" role="status">{copy.privateActive} · {copy.expires} {new Date(status!.captures.privateUntil).toLocaleTimeString(language)} <button type="button" onClick={() => capture({ action: "private-stop" })}>{copy.stopPrivate}</button></p> : null}
    {debugActive ? <p className="diagnostic-debug-banner">{copy.debugActive} · {copy.expires} {new Date(status!.captures.debugUntil).toLocaleTimeString(language)}</p> : null}
    <nav className="diagnostic-tabs" aria-label={copy.title}>{(["overview", "operations", "advanced", "capture"] as const).map(value => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} onClick={() => { controller.setTab(value); setExpanded(new Set()); }}>{copy[value]}</button>)}</nav>
    {state.error ? <p role={state.error === "cancelled" ? "status" : "alert"} className="diagnostic-error">{diagnosticErrors[language][state.error]}</p> : null}
    {state.statusError ? <p role="status" className="diagnostic-error">{copy.unavailable} · {copy.unknown}</p> : null}
    {result.incomplete || trace.incomplete ? <p role="status">{copy.incomplete}</p> : null}
    {[...new Set([...result.notices, ...trace.notices, ...(status?.notices ?? [])])].map(message => <p className="diagnostic-notice" key={message}>{message}</p>)}
    {tab === "overview" ? <><div className="diagnostic-metrics">{([[copy.operations, status?.operationCount], [copy.problems, status?.problemCount], [copy.events, status?.eventCount], [copy.stored, status ? bytes(status.bytes) : undefined]] as const).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? "—"}</strong></div>)}</div>
      <div className="diagnostic-health"><strong>{copy.runtimeHealth}</strong><span>{copy.runtimeStates[status?.runtime?.state ?? "unknown"]}</span></div><div className="diagnostic-health"><strong>{copy.collection}</strong><span>{status?.available ? copy.healthy : copy.unavailable}</span><span>{copy.dropped}: {status?.dropped ?? "—"}</span></div><h2>{copy.recentProblems}</h2></> : null}
    {tab === "operations" || tab === "advanced" ? <form className="diagnostic-filters" onSubmit={event => { event.preventDefault(); refresh(); }}>
      <label className="diagnostic-search"><span>{copy.search}</span><input type="search" value={filters.search} onChange={event => controller.setFilters({ search: event.target.value })} placeholder={copy.search} maxLength={filters.regex ? 256 : 512} aria-invalid={state.filterError === "regex"} aria-describedby={state.filterError === "regex" ? "diagnostic-filter-error" : undefined} /></label>
      <label><span>{copy.searchMode}</span><select value={filters.regex ? "regex" : "text"} onChange={event => controller.setFilters({ regex: event.target.value === "regex" })}><option value="text">{copy.text}</option><option value="regex">{copy.regex}</option></select></label>
      <label><span>{copy.severity}</span><select value={filters.severity} onChange={event => controller.setFilters({ severity: event.target.value })}><option value="">{copy.all}</option>{["debug", "info", "warning", "error"].map(level => <option key={level} value={level}>{stateLabel(level)}</option>)}</select></label>
      {(["component", "target"] as const).map(field => <label key={field}><span>{copy[field]}</span><select value={filters[field]} onChange={event => controller.setFilters({ [field]: event.target.value })}><option value="">{copy.all}</option>{(field === "component" ? status?.components : status?.targets)?.map(value => <option value={value} key={value}>{value}</option>)}</select></label>)}
      {tab === "advanced" ? (["task", "trace", "from", "to"] as const).map(field => <label key={field}><span>{copy[field]}</span><input type={field === "from" || field === "to" ? "datetime-local" : "text"} value={filters[field]} onChange={event => controller.setFilters({ [field]: event.target.value })} maxLength={field === "trace" ? 32 : 256} aria-invalid={state.filterError === (field === "from" || field === "to" ? "date" : field)} /></label>) : null}
      {state.filterError ? <p id="diagnostic-filter-error" role="alert">{labels.validation[state.filterError]}</p> : null}
      <div className="diagnostic-filter-actions"><button type="button" aria-pressed={state.live} onClick={() => controller.setLive(!state.live)}>{state.live ? copy.pause : copy.resume}</button><div className="diagnostic-search-progress" aria-live="polite">{state.searching ? <><span>{labels.searching}</span><button type="button" onClick={() => controller.cancelSearch()}>{copy.cancel}</button></> : null}</div></div><p>{copy.searchHelp}</p>
    </form> : null}
    {tab !== "capture" ? <div className="diagnostic-new-activity">{state.newActivity ? <button type="button" onClick={refresh}>{labels.newActivity}</button> : null}</div> : null}
    {tab !== "capture" ? <div className={`diagnostic-split ${selection ? "has-detail" : ""}`}><section className="diagnostic-results" aria-label={tab === "overview" ? copy.recentProblems : copy.events} aria-busy={state.loading}>
      {state.loading && !result.events.length ? <p role="status">{copy.pending}</p> : null}{!state.loading && !result.events.length ? <p className="diagnostic-empty">{copy.empty}</p> : null}
      {tab === "advanced" ? <VirtualEvents label={copy.events} events={result.events} render={record} /> : tab === "overview" && result.groups ? result.groups.map(group => {
        const representative = result.events.find(event => event.id === group.eventId), occurrences = state.groups[group.key];
        return <section className="diagnostic-group" key={group.key}>{representative ? record(representative) : null}<p>{group.occurrences} {labels.occurrences} · {labels.first}: {new Date(group.firstTime).toLocaleString(language)} · {labels.latest}: {new Date(group.lastTime).toLocaleString(language)}</p><button type="button" aria-expanded={expanded.has(group.key)} onClick={() => {
          controller.setGroupExpanded(group.key, !expanded.has(group.key));
          setExpanded(current => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; });
          if (!expanded.has(group.key) && !occurrences) void launcherActions.run("group", () => controller.loadGroup(group.key), { scope: group.key });
        }}>{labels.occurrences}</button>{expanded.has(group.key) ? <div className="diagnostic-occurrences">{occurrences?.events.map(record)}{occurrences?.nextCursor ? <button type="button" onClick={() => void launcherActions.run("group", () => controller.loadGroup(group.key, true), { scope: group.key })}>{copy.more}</button> : null}</div> : null}</section>;
      }) : result.events.map(record)}
      {result.nextCursor && result.events.length < 1000 ? <button type="button" disabled={state.loading || state.loadingMore} title={state.loading || state.loadingMore ? copy.pending : undefined} onClick={() => void launcherActions.run("more", () => controller.more())}>{copy.more}</button> : result.events.length >= 1000 ? <p>{copy.limit}</p> : null}
    </section><aside ref={inspector} tabIndex={-1} className="diagnostic-inspector" aria-label={copy.detail}>
      {selection ? <><button type="button" className="diagnostic-back" onClick={back}>{copy.back}</button><h2>{detail ? title(detail) : copy.detail}</h2>
        {selection.unavailable ? <p role="status">{copy.incomplete}</p> : null}
        {detail ? <><p>{detail.body}</p><dl><dt>{copy.outcome}</dt><dd>{stateLabel(detail.span?.outcome ?? detail.severity)}</dd><dt>{copy.duration}</dt><dd>{duration(detail)}</dd>{detail.problem ? <><dt>{copy.recovery}</dt><dd>{recoveryLabel(detail.problem.recovery)}</dd></> : null}</dl></> : null}
        {hasOutcomeConflict(detail, trace.events) ? <p className="diagnostic-notice">{labels.conflict}</p> : null}
        {detail?.problem ? <><p>{detail.problem.message}</p>{detail.problem.findings.map((finding, index) => <p key={index}>{finding.path ? <code>{finding.path}: </code> : null}{finding.message}</p>)}<RecoveryActions actions={detail.problem.actions.filter(action => action !== "open-diagnostics")} traceId={traceId} language={language} /></> : null}
        {traceId ? <><h3>{copy.timeline}</h3><ol className="diagnostic-timeline">{stages.map(({ event: stage, depth, parentName, missingParent, cycle }) => <li key={stage.spanId} data-outcome={stage.span?.outcome} data-depth={depth}><button type="button" style={{ "--stage-depth": Math.min(depth, 5) } as CSSProperties} onClick={event => open(stage, event.currentTarget)}><strong>{title(stage)}</strong><span>{stateLabel(stage.span!.outcome)} · {duration(stage)}</span>{parentName ? <small>{labels.parent}: {parentName}</small> : null}{missingParent || cycle ? <small>{labels.missingParent}</small> : null}</button></li>)}</ol>
          {trace.nextCursor ? <button type="button" onClick={() => void launcherActions.run("more", () => controller.loadTrace(true), { scope: "timeline" })}>{copy.more}</button> : null}<small>{copy.trace}: <code>{traceId}</code></small></> : <p>{copy.uncorrelated}</p>}
        {detail ? <details><summary>{copy.technical}</summary><pre>{JSON.stringify(detail, null, 2)}</pre></details> : null}
      </> : <p className="diagnostic-empty">{copy.choose}</p>}
    </aside></div> : <div className="diagnostic-capture-grid">
      <section><h2>{copy.normal}</h2><p>{copy.normalHelp}</p><p>{copy.retention}: {status?.retention.days ?? "—"} {copy.days} / {status ? bytes(status.retention.bytes) : "—"}</p><p>{copy.stored}: {status ? bytes(status.bytes) : "—"}</p><button type="button" onClick={() => setConfirmClear("normal")}>{copy.clearNormal}</button></section>
      <section><h2>{copy.debug}</h2><p>{copy.debugHelp}</p><p>{debugActive ? `${copy.expires}: ${new Date(status!.captures.debugUntil).toLocaleTimeString(language)}` : state.statusError ? copy.unknown : copy.off}</p><button type="button" onClick={() => capture({ action: debugActive ? "debug-stop" : "debug-start" })}>{debugActive ? copy.stopDebug : copy.startDebug}</button></section>
      <section className="diagnostic-private"><h2>{copy.private}</h2><p>{copy.privateHelp}</p><p>{copy.privateSession}</p><p>{copy.stored}: {status ? bytes(status.privateBytes) : "—"}</p><label><span>{copy.scope}</span><select value={captureScope} onChange={event => setCaptureScope(event.target.value)}><option value="next-browser-turn">{copy.nextTurn}</option>{captureScope !== "next-browser-turn" ? <option value={captureScope}>{copy.selectedTrace}</option> : initialTrace ? <option value={initialTrace}>{copy.selectedTrace}</option> : null}</select></label>
        {!privateActive ? <label className="diagnostic-consent"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>{copy.consent}</span></label> : null}
        <div className="diagnostics-tools"><button type="button" disabled={!privateActive && !acknowledged} title={!privateActive && !acknowledged ? copy.consent : undefined} onClick={() => capture(privateActive ? { action: "private-stop" } : { action: "private-start", scope: captureScope, acknowledged: true })}>{privateActive ? copy.stopPrivate : copy.startPrivate}</button><button type="button" onClick={() => setConfirmClear("private")}>{copy.clearPrivate}</button></div>
      </section></div>}
    <dialog ref={clearDialog} className="diagnostic-confirm" aria-label={copy.confirmClear} onCancel={() => setConfirmClear(undefined)}><p>{confirmClear === "private" ? copy.clearPrivate : copy.clearNormal}</p><p>{copy.confirmClear}</p><button type="button" autoFocus onClick={() => setConfirmClear(undefined)}>{copy.keep}</button><button type="button" onClick={() => { const scope = confirmClear; setConfirmClear(undefined); if (scope) void launcherActions.run("clear", async () => { await api.clear(scope, true); controller.cleared(); }); }}>{copy.clear}</button></dialog>
    <footer className="diagnostic-privacy">{labels.help}</footer>
  </section>;
}

function VirtualEvents({ events, render, label }: { events: DiagnosticEvent[]; render: (event: DiagnosticEvent) => ReactNode; label: string }) {
  const [scroll, setScroll] = useState(0); const height = 112; const start = Math.max(0, Math.floor(scroll / height) - 3); const end = Math.min(events.length, start + 12);
  const viewport = useRef<HTMLDivElement>(null); const [focusIndex, setFocusIndex] = useState<number>();
  useLayoutEffect(() => { if (focusIndex !== undefined) viewport.current?.querySelector<HTMLButtonElement>(`[data-index="${focusIndex}"] button`)?.focus({ preventScroll: true }); }, [focusIndex, scroll]);
  return <div ref={viewport} className="diagnostic-virtual" role="list" aria-label={label} onScroll={event => setScroll(event.currentTarget.scrollTop)} onKeyDown={event => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!item || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const current = Number(item.dataset.index);
    const next = Math.max(0, Math.min(events.length - 1, event.key === "Home" ? 0 : event.key === "End" ? events.length - 1 : current + (event.key === "ArrowDown" ? 1 : -1)));
    event.currentTarget.scrollTop = next * height; setScroll(event.currentTarget.scrollTop); setFocusIndex(next);
  }}><div style={{ height: events.length * height, position: "relative" }}>{events.slice(start, end).map((event, index) => <div role="listitem" aria-posinset={start + index + 1} aria-setsize={events.length} data-index={start + index} key={event.id} style={{ position: "absolute", top: (start + index) * height, width: "100%", height }}>{render(event)}</div>)}</div></div>;
}
