import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { launcherActions, type ActionNotice } from "./controller";
import type { Language } from "../types";
import { ProblemFindings, RecoveryActions, actionLabels as recoveryLabels } from "../Recovery";
import { diagnosticErrors } from "../diagnostics/errors";
import { groupNotices, noticePolicy, type NoticeGroup } from "./policy";

const launcherLabels = {
  en: { chooseCodexHome: "Choose folder", restartCodex: "Restart Codex", openIntegrationTarget: "Open target window", checkTargetCapabilities: "Check capabilities", setLanguage: "Save language", openSocial: "Open link", completeOnboarding: "Finish setup", openExternal: "Open link", openDevelopmentProfile: "Open DEV profile", copyManualPrompt: "Copy prompt", confirmManualSent: "Confirm sent", closeBrowserTab: "Close browser tab", openLogin: "Open sign-in", openPasskeyLogin: "Open passkey sign-in", installOnePassword: "Enable 1Password", continuePasskeyLogin: "Continue sign-in", logoutChatGpt: "Sign out", smokeTest: "Test browser", verifyMcp: "Verify MCP", doctor: "Run Doctor", previewIntegrationRepair: "Review fix", applyIntegrationRepair: "Apply fix", cancelTurns: "Cancel turns", uninstallIntegration: "Remove integration", setupCore: "Set up Codex", setupMcp: "Set up MCP", setAutostart: "Save startup preference", setBiggerContext: "Update context mode", setZeroRiskPro: "Update Zero Risk Pro", setBrowserInteractionMode: "Change browser mode", setPreference: "Save preference", exportLogs: "Export diagnostics", installUpdate: "Install update" },
  "zh-CN": { chooseCodexHome: "选择文件夹", restartCodex: "重启 Codex", openIntegrationTarget: "打开目标窗口", checkTargetCapabilities: "检查能力", setLanguage: "保存语言", openSocial: "打开链接", completeOnboarding: "完成设置", openExternal: "打开链接", openDevelopmentProfile: "打开 DEV 配置", copyManualPrompt: "复制提示词", confirmManualSent: "确认已发送", closeBrowserTab: "关闭浏览器标签页", openLogin: "打开登录", openPasskeyLogin: "打开通行密钥登录", installOnePassword: "启用 1Password", continuePasskeyLogin: "继续登录", logoutChatGpt: "退出登录", smokeTest: "测试浏览器", verifyMcp: "验证 MCP", doctor: "运行诊断", previewIntegrationRepair: "审核修复", applyIntegrationRepair: "应用修复", cancelTurns: "取消回合", uninstallIntegration: "移除集成", setupCore: "设置 Codex", setupMcp: "设置 MCP", setAutostart: "保存启动偏好", setBiggerContext: "更新上下文模式", setZeroRiskPro: "更新 Zero Risk Pro", setBrowserInteractionMode: "更改浏览器模式", setPreference: "保存偏好", exportLogs: "导出诊断", installUpdate: "安装更新" },
  ja: { chooseCodexHome: "フォルダーを選択", restartCodex: "Codex を再起動", openIntegrationTarget: "対象を開く", checkTargetCapabilities: "機能を確認", setLanguage: "言語を保存", openSocial: "リンクを開く", completeOnboarding: "セットアップを完了", openExternal: "リンクを開く", openDevelopmentProfile: "DEV プロファイルを開く", copyManualPrompt: "プロンプトをコピー", confirmManualSent: "送信を確認", closeBrowserTab: "ブラウザーのタブを閉じる", openLogin: "ログインを開く", openPasskeyLogin: "パスキーログインを開く", installOnePassword: "1Password を有効にする", continuePasskeyLogin: "ログインを続行", logoutChatGpt: "ログアウト", smokeTest: "ブラウザーをテスト", verifyMcp: "MCP を検証", doctor: "診断を実行", previewIntegrationRepair: "修復を確認", applyIntegrationRepair: "修復を適用", cancelTurns: "ターンをキャンセル", uninstallIntegration: "統合を削除", setupCore: "Codex を設定", setupMcp: "MCP を設定", setAutostart: "起動設定を保存", setBiggerContext: "コンテキストを更新", setZeroRiskPro: "Zero Risk Pro を更新", setBrowserInteractionMode: "ブラウザーモードを変更", setPreference: "設定を保存", exportLogs: "診断を出力", installUpdate: "更新をインストール" },
} as const;

const browserExtensionLabels = {
  en: { installBrowserExtension: "Enable browser extension", updateBrowserExtension: "Update browser extension" },
  "zh-CN": { installBrowserExtension: "启用浏览器扩展", updateBrowserExtension: "更新浏览器扩展" },
  ja: { installBrowserExtension: "ブラウザー拡張を有効にする", updateBrowserExtension: "ブラウザー拡張を更新" },
} as const;

export const actionCopy = {
  en: { pending: "Working…", accepted: "Started — awaiting completion", succeeded: "Completed", cancelled: "Cancelled", failed: "Could not complete. Review diagnostics and try again.", dismiss: "Dismiss", refresh: "Refresh", copy: "Copy", export: "Export", capture: "Update capture", clear: "Delete diagnostics", more: "Load more", search: "Search", group: "Load occurrences" },
  "zh-CN": { pending: "正在处理…", accepted: "已启动，等待完成", succeeded: "已完成", cancelled: "已取消", failed: "未能完成。请查看诊断后重试。", dismiss: "关闭", refresh: "刷新", copy: "复制", export: "导出", capture: "更新捕获", clear: "删除诊断", more: "加载更多", search: "搜索", group: "加载发生记录" },
  ja: { pending: "処理中…", accepted: "開始済み — 完了待ち", succeeded: "完了", cancelled: "キャンセル済み", failed: "完了できませんでした。診断を確認して再試行してください。", dismiss: "閉じる", refresh: "更新", copy: "コピー", export: "出力", capture: "記録設定を更新", clear: "診断を削除", more: "さらに読み込む", search: "検索", group: "発生記録を読み込む" },
} as const;

const detailCopy = {
  en: { category: "Category", outcome: "Outcome", severity: "Severity", component: "Component", report: "Report", setup: "Setup", connection: "Connection", action: "Action", info: "Info", success: "Success", error: "Error", details: "Details", history: "History", feedback: "Action feedback", stage: "Stage", updated: "Updated", recovery: "Recovery", causes: "Related causes", code: "Problem code", "runtime-start": "Startup: Codex integration", "bridge-connect": "Check Codex route", "runtime-start-fail-safe": "Restore Codex route", "dev-profile": "Development runtime", "runtime-start-handoff": "Startup status", recoveryStates: { "not-needed": "Not needed", "not-started": "Not attempted — review is required", completed: "Previous route restored; Codex may need a restart to load it", incomplete: "Could not complete", unknown: "Not established" } },
  "zh-CN": { category: "类别", outcome: "结果", severity: "严重程度", component: "组件", report: "报告", setup: "设置", connection: "连接", action: "操作", info: "信息", success: "成功", error: "错误", details: "详情", history: "历史", feedback: "操作结果", stage: "阶段", updated: "更新时间", recovery: "恢复", causes: "相关原因", code: "问题代码", "runtime-start": "启动：Codex 集成", "bridge-connect": "检查 Codex 路由", "runtime-start-fail-safe": "恢复 Codex 路由", "dev-profile": "开发运行时", "runtime-start-handoff": "启动状态", recoveryStates: { "not-needed": "无需恢复", "not-started": "尚未尝试 — 需要审核", completed: "已恢复先前路由；Codex 可能需要重启以加载它", incomplete: "未能完成", unknown: "尚未确定" } },
  ja: { category: "分類", outcome: "結果", severity: "重要度", component: "コンポーネント", report: "レポート", setup: "設定", connection: "接続", action: "操作", info: "情報", success: "成功", error: "エラー", details: "詳細", history: "履歴", feedback: "操作結果", stage: "段階", updated: "更新日時", recovery: "復旧", causes: "関連する原因", code: "問題コード", "runtime-start": "起動：Codex 統合", "bridge-connect": "Codex ルートを確認", "runtime-start-fail-safe": "Codex ルートを復元", "dev-profile": "開発ランタイム", "runtime-start-handoff": "起動状態", recoveryStates: { "not-needed": "不要", "not-started": "未実行 — 確認が必要", completed: "以前のルートを復元しました。読み込みには Codex の再起動が必要な場合があります", incomplete: "完了できませんでした", unknown: "未確認" } },
} as const;
const backgroundLabels = {
  en: { "runtime-recovery": "Runtime recovery", "runtime-supervisor": "Runtime supervision", "launcher-quit": "Close launcher", "bridge-status": "Check Codex route" },
  "zh-CN": { "runtime-recovery": "运行时恢复", "runtime-supervisor": "运行时管理", "launcher-quit": "关闭启动器", "bridge-status": "检查 Codex 路由" },
  ja: { "runtime-recovery": "ランタイムの復旧", "runtime-supervisor": "ランタイムの管理", "launcher-quit": "ランチャーを終了", "bridge-status": "Codex ルートを確認" },
} as const;

export function hasActionDetails(notice: ActionNotice): boolean {
  return Boolean(notice.problem || notice.errorCode || notice.traceId || notice.evidence || notice.status === "failed");
}

const evidenceCopy = {
  en: { browser: "Browser test passed", checks: "Diagnostic checks completed", response: (count: number) => `Received ${count} response characters. Response content is not included in diagnostics.`, counts: (total: number, issues: number) => `${total} checks completed; ${issues} require attention.` },
  "zh-CN": { browser: "浏览器测试通过", checks: "诊断检查已完成", response: (count: number) => `收到 ${count} 个响应字符。诊断不包含响应内容。`, counts: (total: number, issues: number) => `已完成 ${total} 项检查；${issues} 项需要处理。` },
  ja: { browser: "ブラウザーテストに成功しました", checks: "診断チェックが完了しました", response: (count: number) => `${count} 文字の応答を受信しました。応答内容は診断に含まれません。`, counts: (total: number, issues: number) => `${total} 件のチェックが完了し、${issues} 件に対応が必要です。` },
};

export function ActionFeedback({ language, actionKeys, since = 0 }: { language: Language; actionKeys?: readonly string[]; since?: number }) {
  const allNotices = useSyncExternalStore(launcherActions.subscribe, launcherActions.getSnapshot);
  const notices = actionKeys ? allNotices.filter(notice => actionKeys.includes(notice.key) && (notice.startedAt ?? notice.updatedAt ?? 0) >= since) : allNotices;
  const inline = Boolean(actionKeys);
  const id = useId();
  const detailsId = inline ? `action-details-${id}` : "action-notice-details";
  const [selectedId, setSelectedId] = useState<string>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<string[]>([]);
  const [severities, setSeverities] = useState<string[]>([]);
  const [components, setComponents] = useState<string[]>([]);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (restoreFocus.current) { restoreFocus.current = false; (toggleRef.current ?? historyRef.current ?? dismissRef.current)?.focus(); }
  }, [selectedId, historyOpen]);
  useEffect(() => selectedId ? launcherActions.retain(selectedId) : undefined, [selectedId]);
  useEffect(() => { if (selectedId && !notices.some(notice => notice.id === selectedId)) setSelectedId(undefined); }, [notices, selectedId]);
  useEffect(() => {
    if (!selectedId && !historyOpen) return;
    const close = () => { setSelectedId(undefined); setHistoryOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && (inline || !document.querySelector("dialog[open]"))) { event.preventDefault(); restoreFocus.current = true; close(); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panelRef.current?.contains(event.target)) close(); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [selectedId, historyOpen, inline]);
  const copy = actionCopy[language];
  const extra = detailCopy[language];
  const groups = groupNotices(notices);
  if (!groups.length) return null;
  const selected = notices.find(notice => notice.id === selectedId);
  const visible = groups.filter(group => group.ids.some(id => !notices.find(notice => notice.id === id)?.dismissedAt)).slice(0, 3);
  const current = selected ?? groups[0].notice;
  const label = (key: string) => copy[key as keyof typeof copy] ?? launcherLabels[language][key as keyof typeof launcherLabels.en] ?? browserExtensionLabels[language][key as keyof typeof browserExtensionLabels.en] ?? recoveryLabels[language][key as keyof typeof recoveryLabels.en] ?? backgroundLabels[language][key as keyof typeof backgroundLabels.en] ?? (key in extra && typeof extra[key as keyof typeof extra] === "string" ? String(extra[key as keyof typeof extra]) : key.replace(/[._:-]+/g, " "));
  const summary = (notice: ActionNotice) => notice.problem?.message ?? (notice.errorCode ? diagnosticErrors[language][notice.errorCode] : notice.evidence ? evidenceCopy[language][notice.evidence.kind === "browser-test" ? "browser" : "checks"] : notice.detail ?? copy[notice.status]);
  const actions = current.problem?.actions ?? (current.status === "failed" || current.traceId ? ["open-diagnostics" as const] : []);
  const dismiss = (notice: ActionNotice) => { const group = groups.find(group => group.ids.includes(notice.id)); for (const id of group?.ids ?? [notice.id]) launcherActions.dismiss(id); if (notice.id === selectedId) setSelectedId(undefined); };
  const timestamp = (at: number) => new Date(at).toLocaleString(language, { timeZoneName: "short" });
  const history = groups.filter(group => {
    const policy = noticePolicy(group.notice);
    return (!categories.length || categories.includes(policy.category)) && (!outcomes.length || outcomes.includes(group.notice.status))
      && (!severities.length || severities.includes(policy.severity)) && (!components.length || components.includes(policy.component))
      && `${label(group.notice.key)} ${summary(group.notice)} ${group.notice.problem?.code ?? ""} ${group.notice.traceId ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase());
  });
  return <section ref={panelRef} className={`launcher-action-feedback${inline ? " is-inline" : ""}`} aria-label={extra.feedback}>
    <div className="launcher-action-stack">{visible.map(group => <TimedNotice key={group.notice.id} group={group} dismiss={() => dismiss(group.notice)}>
      <div className="launcher-action-summary" role={group.notice.status === "failed" ? "alert" : "status"}>
        <strong><span className="notification-status-icon" aria-hidden="true">{group.notice.status === "failed" ? "!" : group.notice.status === "succeeded" ? "✓" : group.notice.status === "cancelled" ? "−" : "…"}</span>{label(group.notice.key)}{group.count > 1 ? ` × ${group.count}` : ""}</strong><p>{summary(group.notice)}</p>
        <small><time dateTime={new Date(group.latestAt).toISOString()}>{timestamp(group.latestAt)}</time> · {extra[noticePolicy(group.notice).category]}</small>
      </div><div className="launcher-action-controls">
        {hasActionDetails(group.notice) ? <button type="button" aria-expanded={selectedId === group.notice.id} aria-controls={detailsId} onClick={() => { setHistoryOpen(false); setSelectedId(selectedId === group.notice.id ? undefined : group.notice.id); }}>{extra.details}</button> : null}
        {group.notice.status !== "pending" ? <button type="button" onClick={() => dismiss(group.notice)}>{copy.dismiss}</button> : null}
      </div></TimedNotice>)}</div>
    <button className="launcher-notification-history-button" ref={historyRef} type="button" aria-expanded={historyOpen} onClick={() => { setSelectedId(undefined); setHistoryOpen(value => !value); }}>{extra.history} ({groups.length})</button>
    {selected || historyOpen ? <div className="launcher-action-expanded">
      {selected ? <div id={detailsId} className="launcher-action-details">
        <h3>{label(current.key)}</h3>
        {current.evidence ? <p>{current.evidence.kind === "browser-test" ? evidenceCopy[language].response(current.evidence.responseCharacters) : evidenceCopy[language].counts(current.evidence.total, current.evidence.issues)}</p> : null}
        {current.detail && current.detail !== summary(current) ? <p>{current.detail}</p> : null}
        {current.problem ? <><ProblemFindings findings={current.problem.findings} />
          {current.problem.causes.length ? <><h4>{extra.causes}</h4><ul>{current.problem.causes.map((cause, index) => <li key={index}><code>{cause.code}</code><p>{cause.message}</p></li>)}</ul></> : null}
          <dl><dt>{extra.code}</dt><dd><code>{current.problem.code}</code></dd>
          {current.problem.stage ? <><dt>{extra.stage}</dt><dd>{current.problem.stage}</dd></> : null}
          <dt>{extra.recovery}</dt><dd>{extra.recoveryStates[current.problem.recovery]}</dd></dl>
          {current.problem.evidenceMissing ? <p>{current.problem.evidenceMissing}</p> : null}
          {current.problem.stack ? <pre>{current.problem.stack}</pre> : null}
          {current.problem.httpStatus ? <p>HTTP: {current.problem.httpStatus} · {current.problem.code}</p> : null}
        </> : null}
        {current.updatedAt ? <p>{extra.updated}: <time dateTime={new Date(current.updatedAt).toISOString()}>{new Date(current.updatedAt).toLocaleString(language)}</time></p> : null}
        <RecoveryActions language={language} traceId={current.traceId ?? current.problem?.traceId} actions={actions} />
      </div> : null}
      {historyOpen ? <div className="launcher-action-history" aria-label={extra.history}>
        <label>{copy.search}<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="notification-filters"><label>{extra.category}<select multiple value={categories} onChange={event => setCategories([...event.target.selectedOptions].map(option => option.value))}>{(["report", "setup", "connection", "action"] as const).map(value => <option key={value} value={value}>{extra[value]}</option>)}</select></label>
        <label>{extra.outcome}<select multiple value={outcomes} onChange={event => setOutcomes([...event.target.selectedOptions].map(option => option.value))}>{["pending", "accepted", "succeeded", "cancelled", "failed"].map(value => <option key={value} value={value}>{copy[value as keyof typeof copy]}</option>)}</select></label>
        <label>{extra.severity}<select multiple value={severities} onChange={event => setSeverities([...event.target.selectedOptions].map(option => option.value))}>{(["info", "success", "error"] as const).map(value => <option key={value} value={value}>{extra[value]}</option>)}</select></label>
        <label>{extra.component}<select multiple value={components} onChange={event => setComponents([...event.target.selectedOptions].map(option => option.value))}>{[...new Set(groups.map(group => noticePolicy(group.notice).component))].map(value => <option key={value}>{value}</option>)}</select></label></div>
        {history.map((group, index) => { const notice = group.notice; const date = new Date(group.latestAt).toLocaleDateString(language); return <div key={notice.id}>
        {index === 0 || date !== new Date(history[index - 1].latestAt).toLocaleDateString(language) ? <h4>{date}</h4> : null}<article data-status={notice.status}>
        <div><strong>{label(notice.key)}</strong><p>{summary(notice)}</p>
          <small>{group.count} × · {timestamp(group.firstAt)} — {timestamp(group.latestAt)}</small>
          {hasActionDetails(notice) ? <button type="button" onClick={() => { restoreFocus.current = true; setSelectedId(notice.id); setHistoryOpen(false); }}>{extra.details}</button> : null}
        </div>{notice.status !== "pending" ? <button type="button" onClick={() => dismiss(notice)}>{copy.dismiss}</button> : null}
      </article></div>; })}</div> : null}
    </div> : null}
  </section>;
}

function TimedNotice({ group, dismiss, children }: { group: NoticeGroup; dismiss: () => void; children: React.ReactNode }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef<number | undefined>(noticePolicy(group.notice).timeout);
  const callback = useRef(dismiss); callback.current = dismiss;
  useEffect(() => { remaining.current = noticePolicy(group.notice).timeout; }, [group.latestAt, group.notice.status]);
  useEffect(() => {
    if (paused || remaining.current === undefined) return;
    const start = Date.now(), timer = setTimeout(() => callback.current(), remaining.current);
    return () => { clearTimeout(timer); if (remaining.current !== undefined) remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
  }, [paused, group.latestAt, group.notice.status]);
  return <div className="launcher-action-latest" data-status={group.notice.status} onMouseEnter={() => setPaused(true)} onMouseLeave={event => { if (!event.currentTarget.contains(document.activeElement)) setPaused(false); }}
    onFocus={() => setPaused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) setPaused(false); }}>{children}</div>;
}
