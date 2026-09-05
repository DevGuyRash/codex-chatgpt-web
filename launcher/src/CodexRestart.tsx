import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { CodexRestartAvailability, CodexRestartResult } from "../../src/contracts/codex-restart";
import type { Language, LauncherApi } from "./types";

export const CodexRestartContext = createContext<() => void>(() => {});
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
    if (!confirmed || availability?.status !== "available" || busy || result) return;
    setBusy(true);
    try { setResult(await api.restartCodex(availability.token)); }
    catch { setResult({ status: "manual", reason: "restart-failed" }); }
    finally { setBusy(false); }
  };
  const manual = availability?.status === "manual" || result?.status === "manual";
  return <dialog ref={dialog} className="configuration-review-dialog" aria-labelledby="codex-restart-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="codex-restart-title" ref={heading} tabIndex={-1}>{copy.title}</h2>
    <p>{copy.finish}</p>
    {!availability ? <p role="status">{copy.checking}</p> : null}
    {availability?.application ? <p><strong>{availability.application}</strong></p> : null}
    {availability?.location ? <details><summary>{copy.details}</summary><code>{availability.location}</code></details> : null}
    {manual ? <><p role="status">{result?.status === "manual" && result.reason === "timeout" ? copy.timeout : copy.failed}</p><p>{copy.manual}</p></> : null}
    {result?.status === "launched" ? <p role="status">{copy.launched}</p> : null}
    {availability?.status === "available" && !result ? <label className="repair-approval"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />{copy.confirm}</label> : null}
    {busy ? <p role="status">{copy.working}</p> : null}
    <div className="repair-actions"><button type="button" className="button-primary" disabled={!confirmed || availability?.status !== "available" || busy || Boolean(result)} onClick={() => void restart()}>{copy.restart}</button><button type="button" className="button-secondary" disabled={busy} onClick={onClose}>{copy.later}</button></div>
  </dialog>;
}
