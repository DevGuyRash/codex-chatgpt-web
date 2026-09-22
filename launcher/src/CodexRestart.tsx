import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { CodexRestartAvailability, CodexRestartResult, RestartReason } from "../../src/contracts/codex-restart";
import type { Language, LauncherApi } from "./types";

export const CodexRestartContext = createContext<() => void>(() => {});
export const restartReasons: Record<Language, Record<RestartReason, string>> = {
  en: { busy: "Known bridge work is still active. Finish it before requesting a restart.", stale: "The application changed since it was identified. Reopen Restart options to check again.", ambiguous: "More than one application matches Codex; choose the intended application manually.", "not-found": "No running Codex desktop application was identified.", unsupported: "Automatic restart is not supported for this environment.", "discovery-failed": "The running Codex application could not be identified.", timeout: "Codex did not exit within 30 seconds. It has not been force-closed or relaunched.", "restart-failed": "The normal close or launch request failed. Check Codex before trying again." },
  "zh-CN": { busy: "桥接任务仍在运行。请完成后再请求重启。", stale: "应用在识别后发生变化。请重新打开重启选项进行检查。", ambiguous: "多个应用与 Codex 匹配；请手动选择目标应用。", "not-found": "未找到正在运行的 Codex 桌面应用。", unsupported: "此环境不支持自动重启。", "discovery-failed": "无法识别正在运行的 Codex 应用。", timeout: "Codex 未在 30 秒内退出。未强制关闭或重新启动。", "restart-failed": "正常退出或启动请求失败。请检查 Codex 后再试。" },
  ja: { busy: "ブリッジの処理が実行中です。完了してから再起動を要求してください。", stale: "確認後にアプリが変更されました。再起動のオプションを開き直してください。", ambiguous: "Codex に一致するアプリが複数あります。対象を手動で選択してください。", "not-found": "実行中の Codex デスクトップアプリが見つかりませんでした。", unsupported: "この環境では自動再起動に対応していません。", "discovery-failed": "実行中の Codex アプリを特定できませんでした。", timeout: "Codex は 30 秒以内に終了しませんでした。強制終了も再起動も行っていません。", "restart-failed": "通常の終了または起動要求に失敗しました。Codex を確認してから再試行してください。" },
};
const labels = {
  en: { title: "Restart Codex to use these changes", restart: "Restart Codex", later: "Later", finish: "Finish active tasks in Codex before continuing. This app checks known bridge work, but cannot see whether other Codex tasks are idle.", confirm: "I have finished my active tasks and want to restart this application.", checking: "Identifying the Codex desktop application…", working: "Waiting for Codex to close normally…", manual: "Quit Codex completely using its application menu, then reopen it from your usual application shortcut. If it stays in the background, finish any prompts or active work before quitting. For a CLI profile, close and reopen the selected CLI session instead.", failed: "Automatic restart is unavailable. No forced close will be attempted.", timeout: "Codex did not exit within 30 seconds. It has not been force-closed or relaunched.", launched: "Codex was launched. The reminder stays until the connection provides configuration-load evidence.", details: "Application details", reminder: "Restart options" },
  "zh-CN": { title: "重启 Codex 以使用这些更改", restart: "重启 Codex", later: "稍后", finish: "继续前，请完成 Codex 中的活动任务。此应用会检查已知的桥接任务，但无法查看其他 Codex 任务是否空闲。", confirm: "我已完成活动任务，希望重启此应用。", checking: "正在识别 Codex 桌面应用…", working: "正在等待 Codex 正常退出…", manual: "使用应用菜单完全退出 Codex，然后从常用快捷方式重新打开。如果它仍在后台运行，请先完成提示或活动任务。对于 CLI 配置档，请关闭并重新打开所选 CLI 会话。", failed: "无法自动重启。不会尝试强制退出。", timeout: "Codex 未在 30 秒内退出。未强制关闭或重新启动。", launched: "Codex 已启动。在连接提供配置加载证据前，提醒将保留。", details: "应用详情", reminder: "重启选项" },
  ja: { title: "変更を使うには Codex を再起動してください", restart: "Codex を再起動", later: "後で", finish: "続行する前に Codex の実行中タスクを完了してください。このアプリは既知のブリッジ処理を確認しますが、他の Codex タスクが実行中かどうかは確認できません。", confirm: "実行中のタスクを完了し、このアプリを再起動します。", checking: "Codex デスクトップアプリを確認中…", working: "Codex が正常に終了するのを待っています…", manual: "アプリのメニューから Codex を完全に終了し、通常のショートカットから開き直してください。バックグラウンドに残る場合は、確認画面や実行中タスクを完了してから終了してください。CLI プロファイルの場合は、選択した CLI セッションを終了して開き直してください。", failed: "自動再起動は利用できません。強制終了は行いません。", timeout: "Codex は 30 秒以内に終了しませんでした。強制終了も再起動も行っていません。", launched: "Codex を起動しました。設定の読み込みを接続で確認できるまで通知を保持します。", details: "アプリの詳細", reminder: "再起動のオプション" },
};

export function RestartOptions({ language }: { language: Language }) {
  const open = useContext(CodexRestartContext);
  return <button type="button" className="button-secondary" onClick={open}>{labels[language].reminder}</button>;
}

export function CodexRestartDialog({ api, language, onClose }: { api: Pick<LauncherApi, "codexRestartAvailability" | "restartCodex">; language: Language; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [availability, setAvailability] = useState<CodexRestartAvailability | null>(null);
  const [result, setResult] = useState<CodexRestartResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = labels[language];
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal(); heading.current?.focus();
    let current = true;
    void api.codexRestartAvailability().then(value => { if (current) setAvailability(value); }).catch(() => { if (current) setAvailability({ status: "manual", reason: "discovery-failed" }); });
    return () => { current = false; element.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [api]);
  const restart = async () => {
    if ((!confirmed && availability?.status === "available" && availability.mode !== "launch") || availability?.status !== "available" || busy || result) return;
    setBusy(true);
    try { setResult(await api.restartCodex(availability.token)); }
    catch { setResult({ status: "manual", reason: "restart-failed" }); }
    finally { setBusy(false); }
  };
  const launchOnly = availability?.status === "available" && availability.mode === "launch";
  const launchLabel = language === "en" ? "Launch Codex" : language === "ja" ? "Codex を起動" : "启动 Codex";
  const manual = availability?.status === "manual" || result?.status === "manual";
  const reason = result?.status === "manual" ? result.reason : availability?.status === "manual" ? availability.reason : undefined;
  return <dialog ref={dialog} className="configuration-review-dialog" aria-labelledby="codex-restart-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="codex-restart-title" ref={heading} tabIndex={-1}>{launchOnly ? launchLabel : copy.title}</h2>
    {!launchOnly ? <p>{copy.finish}</p> : null}
    {!availability ? <p role="status">{copy.checking}</p> : null}
    {availability?.application ? <p><strong>{availability.application}</strong></p> : null}
    {availability?.location ? <details><summary>{copy.details}</summary><code>{availability.location}</code></details> : null}
    {manual ? <><p role="status">{reason ? restartReasons[language][reason] : copy.failed}</p>{reason !== "timeout" ? <p>{copy.failed}</p> : null}<p>{copy.manual}</p></> : null}
    {result?.status === "launched" ? <p role="status">{copy.launched}</p> : null}
    {availability?.status === "available" && !launchOnly && !result ? <label className="repair-approval"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{copy.confirm}</label> : null}
    {busy ? <p role="status">{copy.working}</p> : null}
    <div className="repair-actions"><button type="button" className="button-primary" disabled={(!confirmed && !launchOnly) || availability?.status !== "available" || busy || Boolean(result)} onClick={() => void restart()}>{launchOnly ? launchLabel : copy.restart}</button><button type="button" className="button-secondary" disabled={busy} onClick={onClose}>{copy.later}</button></div>
  </dialog>;
}
