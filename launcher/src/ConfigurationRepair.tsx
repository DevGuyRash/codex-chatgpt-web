import { useId, useState } from "react";
import type { CodexRepairPreview, Language, LauncherApi, LauncherState, SubagentProtocol } from "./types";

const labels = {
  en: {
    title: "Repair Codex connection", body: "Review configuration differences before changing anything. Active work must finish before a repair can run.",
    protocol: "Subagent protocol", choose: "Choose a protocol…", compatibility: "Compatibility V1 (Native V2 disabled)", native: "Native (preserve newer feature choices)",
    preview: "Preview changes", setting: "Setting", current: "Current", expected: "Installed expectation", proposed: "Proposed", absent: "Not set", unchanged: "Unchanged",
    blocked: "Needs attention: ownership could not be verified. Resolve the conflicts below, then request a fresh preview.",
    approve: "I approve these configuration changes and understand that Codex and the launcher will need restarting.",
    apply: "Apply approved repair", cancel: "Discard preview", working: "Working…", done: "Repair applied. Restart Codex and the launcher to use the repaired connection.",
  },
  "zh-CN": {
    title: "修复 Codex 连接", body: "修改前先查看配置差异。修复前必须等待当前任务结束。",
    protocol: "子代理协议", choose: "选择协议…", compatibility: "兼容 V1（禁用 Native V2）", native: "Native（保留较新的功能选择）",
    preview: "预览更改", setting: "设置", current: "当前值", expected: "安装时的预期值", proposed: "建议值", absent: "未设置", unchanged: "不变",
    blocked: "需要处理：无法验证配置归属。请解决以下冲突，然后重新预览。",
    approve: "我同意这些配置更改，并了解需要重启 Codex 和启动器。",
    apply: "应用已批准的修复", cancel: "放弃预览", working: "处理中…", done: "修复已应用。请重启 Codex 和启动器以使用修复后的连接。",
  },
  ja: {
    title: "Codex 接続を修復", body: "変更前に設定の差分を確認します。修復するには実行中のタスクが完了する必要があります。",
    protocol: "サブエージェントのプロトコル", choose: "プロトコルを選択…", compatibility: "互換 V1（Native V2 を無効化）", native: "Native（新しい機能の選択を保持）",
    preview: "変更をプレビュー", setting: "設定", current: "現在の値", expected: "インストール時の想定値", proposed: "変更後", absent: "未設定", unchanged: "変更なし",
    blocked: "要確認：設定の所有権を確認できませんでした。以下の競合を解決してから、再度プレビューしてください。",
    approve: "これらの設定変更を承認します。Codex とランチャーの再起動が必要であることを理解しています。",
    apply: "承認した修復を適用", cancel: "プレビューを破棄", working: "処理中…", done: "修復を適用しました。Codex とランチャーを再起動してください。",
  },
} satisfies Record<Language, Record<string, string>>;

export function ConfigurationRepair({ api, language, disabled, onBusyChange, onRepaired, onError }: {
  api: Pick<LauncherApi, "previewIntegrationRepair" | "applyIntegrationRepair">;
  language: Language;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onRepaired: (state: LauncherState) => void;
  onError: (message: string | null) => void;
}) {
  const copy = labels[language];
  const id = useId();
  const [protocol, setProtocol] = useState<SubagentProtocol | "">("");
  const [preview, setPreview] = useState<CodexRepairPreview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const discard = () => { setPreview(null); setApproved(false); };
  const perform = async (apply: boolean) => {
    if (!protocol || busy || disabled || (apply && (!preview || !approved || preview.status !== "ready"))) return;
    setBusy(true);
    onBusyChange(true);
    onError(null);
    setDone(false);
    try {
      if (apply && preview) {
        const result = await api.applyIntegrationRepair(protocol, preview.approvalId);
        onRepaired(result.state);
        discard();
        setDone(true);
      } else {
        discard();
        setPreview(await api.previewIntegrationRepair(protocol));
      }
    } catch (cause) {
      discard();
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };
  const paths = [...new Set([...(preview?.changes.map((change) => change.path) ?? []), ...(preview?.conflicts.map((conflict) => conflict.path) ?? [])])];
  const value = (item: string | number | boolean | null | undefined) => item == null ? copy.absent : String(item);
  return <section className="configuration-repair" aria-labelledby={`${id}-title`} aria-busy={busy}>
    <h3 id={`${id}-title`}>{copy.title}</h3>
    <p>{copy.body}</p>
    <fieldset className="repair-protocol" disabled={busy || disabled}>
      <legend>{copy.protocol}</legend>
      {(["compatibility-v1", "native"] as const).map((choice) => <label key={choice}>
        <input type="radio" name={`${id}-protocol`} value={choice} checked={protocol === choice} onChange={() => {
          setProtocol(choice); discard(); setDone(false);
        }} />
        <span>{choice === "native" ? copy.native : copy.compatibility}</span>
      </label>)}
    </fieldset>
    <button type="button" className="button-secondary" disabled={!protocol || busy || disabled} onClick={() => void perform(false)}>{busy ? copy.working : copy.preview}</button>
    {preview ? <>
      {preview.status === "blocked" ? <p role="status">{copy.blocked}</p> : null}
      <div className="repair-comparison" tabIndex={0} role="region" aria-label={copy.preview}>
        <table><thead><tr><th>{copy.setting}</th><th>{copy.current}</th><th>{copy.expected}</th><th>{copy.proposed}</th></tr></thead>
          <tbody>{paths.map((path) => {
            const change = preview.changes.find((item) => item.path === path);
            const conflict = preview.conflicts.find((item) => item.path === path);
            return <tr key={path}><th scope="row"><code>{path}</code></th><td>{value(change ? change.current : conflict?.current)}</td><td>{conflict?.expected === undefined ? "—" : value(conflict.expected)}</td><td>{change ? value(change.proposed) : copy.unchanged}</td></tr>;
          })}</tbody>
        </table>
      </div>
      {preview.conflicts.length ? <ul>{preview.conflicts.map((conflict, index) => <li key={`${conflict.path}-${index}`}><code>{conflict.path}</code>: {conflict.message}</li>)}</ul> : null}
      {preview.status === "ready" ? <label className="repair-approval"><input type="checkbox" checked={approved} disabled={busy || disabled} onChange={(event) => setApproved(event.target.checked)} /><span>{copy.approve}</span></label> : null}
      <div className="repair-actions">
        <button type="button" className="button-primary" disabled={preview.status !== "ready" || !approved || busy || disabled} onClick={() => void perform(true)}>{copy.apply}</button>
        <button type="button" className="button-secondary" disabled={busy || disabled} onClick={discard}>{copy.cancel}</button>
      </div>
    </> : null}
    {done ? <p role="status">{copy.done}</p> : null}
  </section>;
}
