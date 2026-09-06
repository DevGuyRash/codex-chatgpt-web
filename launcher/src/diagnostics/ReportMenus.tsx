import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DiagnosticsApi, DiagnosticQuery, ReportSelection } from "../../../src/diagnostics/contracts";
import type { Language } from "../types";
import { launcherActions } from "../actions/controller";

export const reportCopy = {
  en: { copy: "Copy", export: "Export", event: "This event", operation: "This operation", results: "Current results", all: "All retained diagnostics", summary: "Troubleshooting summary", json: "Structured JSON", html: "Readable HTML", bundle: "Support bundle", otlp: "OpenTelemetry", included: "What is included?", help: "Private screenshots, task titles, credentials, and model content are excluded. Correlation IDs, component versions, and timestamps remain. Reports are not anonymous; missing records are not proof of success.", records: "records", incomplete: "Incomplete evidence", searching: "Searching…", newActivity: "New activity", occurrences: "Occurrences", first: "First", latest: "Latest", parent: "Parent", missingParent: "Parent evidence is missing", conflict: "Recorded evidence conflicts: this operation contains both cancellation and error records. The original records are preserved; no cancellation reason has been inferred.", validation: { regex: "Enter a valid regular expression.", trace: "Enter a nonzero 32-character lowercase hexadecimal trace ID.", date: "Enter valid dates with the start no later than the end." } },
  "zh-CN": { copy: "复制", export: "导出", event: "此事件", operation: "此操作", results: "当前结果", all: "所有保留的诊断", summary: "故障排查摘要", json: "结构化 JSON", html: "可读 HTML", bundle: "支持包", otlp: "OpenTelemetry", included: "包含哪些内容？", help: "不包含私密截图、任务标题、凭据或模型内容。保留关联 ID、组件版本和时间戳。报告并非匿名；缺少记录不代表成功。", records: "条记录", incomplete: "证据不完整", searching: "正在搜索…", newActivity: "新活动", occurrences: "发生记录", first: "首次", latest: "最近", parent: "父阶段", missingParent: "缺少父阶段证据", conflict: "记录存在冲突：此操作同时包含取消和错误记录。原始记录已保留，未推断取消原因。", validation: { regex: "请输入有效的正则表达式。", trace: "请输入非全零的 32 位小写十六进制跟踪 ID。", date: "请输入有效日期，开始时间不得晚于结束时间。" } },
  ja: { copy: "コピー", export: "出力", event: "このイベント", operation: "この操作", results: "現在の検索結果", all: "保存されたすべての診断", summary: "トラブルシューティング概要", json: "構造化 JSON", html: "読みやすい HTML", bundle: "サポートバンドル", otlp: "OpenTelemetry", included: "含まれる情報", help: "プライベート画像、タスク名、認証情報、モデル内容は含みません。関連 ID、バージョン、日時は残ります。匿名のレポートではありません。記録の欠落は成功の証拠ではありません。", records: "件", incomplete: "証拠が不完全です", searching: "検索中…", newActivity: "新しい記録", occurrences: "発生記録", first: "最初", latest: "最新", parent: "親ステージ", missingParent: "親ステージの証拠がありません", conflict: "記録が矛盾しています。この操作にはキャンセルとエラーの両方があります。元の記録を保持し、キャンセル理由は推測していません。", validation: { regex: "有効な正規表現を入力してください。", trace: "ゼロ以外の32桁の小文字16進数トレース IDを入力してください。", date: "開始が終了以前となる有効な日時を入力してください。" } },
} as const;

export function ReportMenus({ api, language, query, eventId, traceId, invalid }: { api: DiagnosticsApi; language: Language; query: DiagnosticQuery; eventId?: string; traceId?: string; invalid?: "regex" | "trace" | "date" }) {
  const copy = reportCopy[language];
  const [menu, setMenu] = useState<"copy" | "export">();
  const [scope, setScope] = useState<ReportSelection["kind"]>(traceId ? "operation" : "results");
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement | null>(null), panel = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { setMenu(undefined); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!menu || !panel.current || !trigger.current) return;
    const place = () => {
      const anchor = trigger.current!.getBoundingClientRect(), bounds = panel.current!.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)), top: Math.max(8, anchor.bottom + 6 + bounds.height <= innerHeight - 8 ? anchor.bottom + 6 : anchor.top - bounds.height - 6) });
    };
    place(); panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("scroll", scroll, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("scroll", scroll, true); };
  }, [menu]);
  const scopes = [eventId ? "event" : undefined, traceId ? "operation" : undefined, "results", menu === "export" ? "all" : undefined].filter(Boolean) as ReportSelection["kind"][];
  const chosen = scopes.includes(scope) ? scope : "results";
  const selection = (): ReportSelection => chosen === "event" && eventId ? { kind: "event", eventId } : chosen === "operation" && traceId ? { kind: "operation", traceId } : chosen === "all" ? { kind: "all" } : { kind: "results", query: structuredClone(query) };
  const perform = (format: "summary" | "bundle" | "html" | "json" | "otlp") => {
    const frozen = selection(), action = menu!; close();
    const describe = (value: { records?: number; incomplete?: boolean; path?: string; cancelled?: boolean } | void) => value && !value.cancelled ? `${value.records ?? "—"} ${copy.records}${value.incomplete ? ` · ${copy.incomplete}` : ""}${value.path ? ` · ${value.path}` : ""}` : undefined;
    if (action === "copy") void launcherActions.run("copy", () => api.copy({ format: format === "json" ? "json" : "summary", selection: frozen }), { describe, traceId });
    else void launcherActions.run("export", () => api.export({ format: format === "summary" ? "bundle" : format, selection: frozen }), { describe, traceId });
  };
  return <><div className="diagnostics-tools">{(["copy", "export"] as const).map(action => <button key={action} type="button" aria-haspopup="menu" aria-expanded={menu === action} onClick={event => { if (menu === action) close(); else { trigger.current = event.currentTarget; setMenu(action); } }}>{copy[action]}</button>)}<details><summary>{copy.included}</summary><p>{copy.help}</p></details></div>
    {menu ? createPortal(<div ref={panel} className="diagnostic-report-menu" role="menu" aria-label={copy[menu]} style={position} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Tab") close(false);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")], index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>{scopes.map(value => <button type="button" role="menuitemradio" aria-checked={chosen === value} key={value} onClick={() => setScope(value)}>{copy[value]}</button>)}<hr />
      {(menu === "copy" ? ["summary", "json"] as const : ["bundle", "html", "json", "otlp"] as const).map(format => <button key={format} type="button" role="menuitem" disabled={chosen === "results" && Boolean(invalid)} title={chosen === "results" && invalid ? copy.validation[invalid] : undefined} onClick={() => perform(format)}>{copy[format]}</button>)}
    </div>, document.body) : null}</>;
}
