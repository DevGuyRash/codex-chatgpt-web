import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { launcherActions } from "./controller";
import type { Language } from "../types";
import { RecoveryActions, actionLabels as recoveryLabels } from "../Recovery";
import { diagnosticErrors } from "../diagnostics/errors";

const launcherLabels = {
  en: { chooseCodexHome: "Choose folder", restartCodex: "Restart Codex", openIntegrationTarget: "Open target window", checkTargetCapabilities: "Check capabilities", setLanguage: "Save language", openSocial: "Open link", completeOnboarding: "Finish setup", openExternal: "Open link", copyManualPrompt: "Copy prompt", confirmManualSent: "Confirm sent", openLogin: "Open sign-in", openPasskeyLogin: "Open passkey sign-in", continuePasskeyLogin: "Continue sign-in", logoutChatGpt: "Sign out", smokeTest: "Test browser", verifyMcp: "Verify MCP", doctor: "Run Doctor", previewIntegrationRepair: "Review fix", applyIntegrationRepair: "Apply fix", cancelTurns: "Cancel turns", uninstallIntegration: "Remove integration", setupCore: "Set up Codex", setupMcp: "Set up MCP", setAutostart: "Save startup preference", setBiggerContext: "Update context mode", setZeroRiskPro: "Update Zero Risk Pro", setBrowserInteractionMode: "Change browser mode", setPreference: "Save preference", exportLogs: "Export diagnostics", installUpdate: "Install update" },
  "zh-CN": { chooseCodexHome: "选择文件夹", restartCodex: "重启 Codex", openIntegrationTarget: "打开目标窗口", checkTargetCapabilities: "检查能力", setLanguage: "保存语言", openSocial: "打开链接", completeOnboarding: "完成设置", openExternal: "打开链接", copyManualPrompt: "复制提示词", confirmManualSent: "确认已发送", openLogin: "打开登录", openPasskeyLogin: "打开通行密钥登录", continuePasskeyLogin: "继续登录", logoutChatGpt: "退出登录", smokeTest: "测试浏览器", verifyMcp: "验证 MCP", doctor: "运行诊断", previewIntegrationRepair: "审核修复", applyIntegrationRepair: "应用修复", cancelTurns: "取消回合", uninstallIntegration: "移除集成", setupCore: "设置 Codex", setupMcp: "设置 MCP", setAutostart: "保存启动偏好", setBiggerContext: "更新上下文模式", setZeroRiskPro: "更新 Zero Risk Pro", setBrowserInteractionMode: "更改浏览器模式", setPreference: "保存偏好", exportLogs: "导出诊断", installUpdate: "安装更新" },
  ja: { chooseCodexHome: "フォルダーを選択", restartCodex: "Codex を再起動", openIntegrationTarget: "対象を開く", checkTargetCapabilities: "機能を確認", setLanguage: "言語を保存", openSocial: "リンクを開く", completeOnboarding: "セットアップを完了", openExternal: "リンクを開く", copyManualPrompt: "プロンプトをコピー", confirmManualSent: "送信を確認", openLogin: "ログインを開く", openPasskeyLogin: "パスキーログインを開く", continuePasskeyLogin: "ログインを続行", logoutChatGpt: "ログアウト", smokeTest: "ブラウザーをテスト", verifyMcp: "MCP を検証", doctor: "診断を実行", previewIntegrationRepair: "修復を確認", applyIntegrationRepair: "修復を適用", cancelTurns: "ターンをキャンセル", uninstallIntegration: "統合を削除", setupCore: "Codex を設定", setupMcp: "MCP を設定", setAutostart: "起動設定を保存", setBiggerContext: "コンテキストを更新", setZeroRiskPro: "Zero Risk Pro を更新", setBrowserInteractionMode: "ブラウザーモードを変更", setPreference: "設定を保存", exportLogs: "診断を出力", installUpdate: "更新をインストール" },
} as const;

export const actionCopy = {
  en: { pending: "Working…", accepted: "Started — awaiting completion", succeeded: "Completed", cancelled: "Cancelled", failed: "Could not complete. Review diagnostics and try again.", dismiss: "Dismiss", refresh: "Refresh", copy: "Copy", export: "Export", capture: "Update capture", clear: "Delete diagnostics", more: "Load more", search: "Search", group: "Load occurrences" },
  "zh-CN": { pending: "正在处理…", accepted: "已启动，等待完成", succeeded: "已完成", cancelled: "已取消", failed: "未能完成。请查看诊断后重试。", dismiss: "关闭", refresh: "刷新", copy: "复制", export: "导出", capture: "更新捕获", clear: "删除诊断", more: "加载更多", search: "搜索", group: "加载发生记录" },
  ja: { pending: "処理中…", accepted: "開始済み — 完了待ち", succeeded: "完了", cancelled: "キャンセル済み", failed: "完了できませんでした。診断を確認して再試行してください。", dismiss: "閉じる", refresh: "更新", copy: "コピー", export: "出力", capture: "記録設定を更新", clear: "診断を削除", more: "さらに読み込む", search: "検索", group: "発生記録を読み込む" },
} as const;

export function ActionFeedback({ language }: { language: Language }) {
  const notices = useSyncExternalStore(launcherActions.subscribe, launcherActions.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setExpanded(false); toggleRef.current?.focus(); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panelRef.current?.contains(event.target)) setExpanded(false); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [expanded]);
  useEffect(() => { if (!notices.length) setExpanded(false); }, [notices.length]);
  const copy = actionCopy[language];
  if (!notices.length) return null;
  const latest = notices[0];
  const label = (key: string) => copy[key as keyof typeof copy] ?? launcherLabels[language][key as keyof typeof launcherLabels.en] ?? recoveryLabels[language][key as keyof typeof recoveryLabels.en] ?? key;
  const detailsLabel = language === "en" ? "Details" : language === "ja" ? "詳細" : "详情";
  const panel = <section ref={panelRef} className="launcher-action-feedback" aria-label={language === "en" ? "Action feedback" : language === "ja" ? "操作結果" : "操作结果"}>
    <div className="launcher-action-latest" data-status={latest.status}>
      <div className="launcher-action-summary" role={latest.status === "failed" ? "alert" : "status"}>
        <strong title={label(latest.key)}>{label(latest.key)}</strong><p title={copy[latest.status]}>{copy[latest.status]}</p>
        {latest.detail ? <p title={latest.detail}>{latest.detail}</p> : null}
      </div>
      <button ref={toggleRef} type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{detailsLabel} ({notices.length})</button>
      {latest.status !== "pending" ? <button type="button" onClick={() => launcherActions.dismiss(latest.id)}>{copy.dismiss}</button> : null}
    </div>
    {expanded ? <div className="launcher-action-history">
    {notices.map(notice => <article key={notice.id} data-status={notice.status}>
      <div><strong>{label(notice.key)}</strong><p>{copy[notice.status]}</p>{notice.errorCode ? <p>{diagnosticErrors[language][notice.errorCode]}</p> : null}{notice.detail ? <p>{notice.detail}</p> : null}
        {notice.status === "failed" ? <RecoveryActions language={language} traceId={notice.traceId} actions={notice.problem?.actions ?? ["open-diagnostics"]} /> : null}
      </div>
      {notice.status !== "pending" ? <button type="button" onClick={() => launcherActions.dismiss(notice.id)}>{copy.dismiss}</button> : null}
    </article>)}</div> : null}
  </section>;
  const dialog = document.querySelector("dialog[open]");
  return dialog ? createPortal(panel, dialog) : panel;
}
