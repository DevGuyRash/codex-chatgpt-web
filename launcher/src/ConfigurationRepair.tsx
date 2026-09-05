import { useEffect, useId, useRef, useState } from "react";
import type { CodexRepairPreview, Language, LauncherApi, LauncherState, SubagentProtocol } from "./types";

const labels = {
  en: {
    title: "Repair Codex connection", body: "Review configuration differences before changing anything. Active work must finish before a repair can run.",
    protocol: "Subagent protocol", choose: "Choose a protocol…", compatibility: "Compatibility V1 (Native V2 disabled)", native: "Native (preserve newer feature choices)",
    preview: "Preview changes", setting: "Setting", current: "Current", expected: "Installed expectation", proposed: "Proposed", absent: "Not set", unchanged: "Unchanged", commented: "Commented out (inactive)",
    blocked: "This preview cannot be applied. Review the findings below, resolve the blocking issues, then request a fresh preview.",
    approve: "I approve these configuration changes and understand that Codex and the launcher will need restarting.",
    apply: "Apply approved repair", cancel: "Discard preview", working: "Working…", done: "Repair applied. Restart Codex and the launcher to use the repaired connection.",
  },
  "zh-CN": {
    title: "修复 Codex 连接", body: "修改前先查看配置差异。修复前必须等待当前任务结束。",
    protocol: "子代理协议", choose: "选择协议…", compatibility: "兼容 V1（禁用 Native V2）", native: "Native（保留较新的功能选择）",
    preview: "预览更改", setting: "设置", current: "当前值", expected: "安装时的预期值", proposed: "建议值", absent: "未设置", unchanged: "不变", commented: "已注释（未启用）",
    blocked: "无法应用此预览。请查看下方检查结果，解决阻碍问题后重新预览。",
    approve: "我同意这些配置更改，并了解需要重启 Codex 和启动器。",
    apply: "应用已批准的修复", cancel: "放弃预览", working: "处理中…", done: "修复已应用。请重启 Codex 和启动器以使用修复后的连接。",
  },
  ja: {
    title: "Codex 接続を修復", body: "変更前に設定の差分を確認します。修復するには実行中のタスクが完了する必要があります。",
    protocol: "サブエージェントのプロトコル", choose: "プロトコルを選択…", compatibility: "互換 V1（Native V2 を無効化）", native: "Native（新しい機能の選択を保持）",
    preview: "変更をプレビュー", setting: "設定", current: "現在の値", expected: "インストール時の想定値", proposed: "変更後", absent: "未設定", unchanged: "変更なし", commented: "コメントアウト（無効）",
    blocked: "このプレビューは適用できません。以下の確認結果を見て、問題を解決してから再度プレビューしてください。",
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
      <ConfigurationChanges preview={preview} language={language} />
      {preview.status === "ready" ? <label className="repair-approval"><input type="checkbox" checked={approved} disabled={busy || disabled} onChange={(event) => setApproved(event.target.checked)} /><span>{copy.approve}</span></label> : null}
      <div className="repair-actions">
        <button type="button" className="button-primary" disabled={preview.status !== "ready" || !approved || busy || disabled} onClick={() => void perform(true)}>{copy.apply}</button>
        <button type="button" className="button-secondary" disabled={busy || disabled} onClick={discard}>{copy.cancel}</button>
      </div>
    </> : null}
    {done ? <p role="status">{copy.done}</p> : null}
  </section>;
}

export function ConfigurationChanges({ preview, language }: { preview: CodexRepairPreview; language: Language }) {
  const copy = labels[language];
  const paths = [...new Set([...preview.changes.map(change => change.path), ...preview.conflicts.filter(conflict => conflict.current !== undefined || conflict.expected !== undefined || ["missing", "commented_out", "value_changed"].includes(conflict.category)).map(conflict => conflict.path)])];
  const value = (item: string | number | boolean | null | undefined) => item == null ? copy.absent : String(item);
  return <>
    {paths.length ? <div className="repair-comparison" tabIndex={0} role="region" aria-label={copy.preview}>
      <table><thead><tr><th>{copy.setting}</th><th>{copy.current}</th><th>{copy.expected}</th><th>{copy.proposed}</th></tr></thead>
        <tbody>{paths.map(path => {
          const change = preview.changes.find(item => item.path === path);
          const conflict = preview.conflicts.find(item => item.path === path);
          return <tr key={path}><th scope="row"><code>{path}</code></th>
            <td>{conflict?.category === "commented_out" || change?.currentState === "commented_out" ? copy.commented : value(change ? change.current : conflict?.current)}
              {change?.currentLines?.length ? <small className="configuration-source-lines">{language === "en" ? "Line" : language === "ja" ? "行" : "行"} {change.currentLines.join(", ")}</small> : null}</td>
            <td>{conflict?.expected === undefined ? "—" : value(conflict.expected)}</td><td>{preview.status === "blocked" ? "—" : change ? value(change.proposed) : conflict?.current !== undefined ? `${copy.unchanged} (${value(conflict.current)})` : copy.unchanged}</td></tr>;
        })}</tbody>
      </table>
    </div> : null}
    {preview.conflicts.length ? <section className="configuration-findings"><h3>{language === "en" ? "Configuration findings" : language === "ja" ? "設定の確認結果" : "配置检查结果"}</h3><ul className="diagnostic-findings">{preview.conflicts.map((conflict, index) => <li key={`${conflict.path}-${index}`}><code>{conflict.path}</code><p>{conflict.message}</p></li>)}</ul></section> : null}
    {preview.effects?.length ? <ul>{preview.effects.map(effect => <li key={effect}>{effect}</li>)}</ul> : null}
    {preview.textChanges?.map(change => <details className="configuration-text-change" key={change.path}>
      <summary>{language === "en" ? "Exact file changes" : language === "ja" ? "ファイルの変更内容" : "文件的具体更改"}: <code>{change.path}</code> ({change.startLine})</summary>
      <div><section><h4>{copy.current}</h4><pre>{change.before || copy.absent}</pre></section><section><h4>{copy.proposed}</h4><pre>{change.after || copy.absent}</pre></section></div>
    </details>)}
  </>;
}

const setupLabels = {
  en: { title: "Review setup changes", body: "These are the proposed Codex configuration changes. Setup has not stopped the runtime or applied these changes yet.", approve: "I approve these changes and the setup actions listed above.", apply: "Approve and continue setup", cancel: "Cancel setup" },
  "zh-CN": { title: "查看设置更改", body: "以下是 Codex 配置的建议更改。设置尚未停止运行时或应用这些更改。", approve: "我同意这些更改及上述设置操作。", apply: "批准并继续设置", cancel: "取消设置" },
  ja: { title: "セットアップの変更を確認", body: "Codex 設定の変更案です。ランタイムの停止や設定の適用はまだ行われていません。", approve: "これらの変更と上記のセットアップ操作を承認します。", apply: "承認してセットアップを続行", cancel: "セットアップをキャンセル" },
};

export function SetupConfigurationReview({ preview, language, decide }: {
  preview: CodexRepairPreview; language: Language; decide: (id: string, decision: boolean | SubagentProtocol) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [approvedId, setApprovedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = setupLabels[language];
  const approved = preview.status === "ready" && !preview.refreshing && approvedId === preview.approvalId;
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  const submit = async (accept: boolean | SubagentProtocol) => {
    if (busy || (accept !== false && preview.refreshing) || (accept === true && !approved)) return;
    setApprovedId(null);
    setError(null);
    if (typeof accept !== "string") setBusy(true);
    try { await decide(preview.approvalId, accept); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="configuration-review-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); void submit(false); }}>
    <section className="configuration-repair">
      <h2 id={`${id}-title`}>{copy.title}</h2><p>{copy.body}</p>
      <fieldset className="repair-protocol" disabled={busy || preview.refreshing}>
        <legend>{labels[language].protocol}</legend>
        {(["compatibility-v1", "native"] as const).map(choice => <label key={choice}>
          <input type="radio" name={`${id}-protocol`} checked={preview.protocol === choice} onChange={() => void submit(choice)} />
          <span>{choice === "native" ? labels[language].native : labels[language].compatibility}</span>
        </label>)}
      </fieldset>
      {preview.refreshing ? <p role="status">{language === "en" ? "Updating comparison… No changes have been applied." : language === "ja" ? "変更内容を更新中です。設定はまだ変更されていません。" : "正在更新对比，尚未应用任何更改。"}</p>
        : preview.status === "blocked" ? <p role="status">{labels[language].blocked}</p> : null}
      <div className="configuration-review-content" aria-busy={preview.refreshing === true}>
        <ConfigurationChanges preview={preview} language={language} />
      </div>
      {preview.status === "ready" ? <label className="repair-approval"><input type="checkbox" checked={approved} disabled={busy || preview.refreshing} onChange={event => setApprovedId(event.target.checked ? preview.approvalId : null)} /><span>{copy.approve}</span></label> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="repair-actions">
        <button className="button-primary" disabled={!approved || busy || preview.status !== "ready"} onClick={() => void submit(true)}>{copy.apply}</button>
        <button className="button-secondary" disabled={busy} onClick={() => void submit(false)}>{copy.cancel}</button>
      </div>
    </section>
  </dialog>;
}
