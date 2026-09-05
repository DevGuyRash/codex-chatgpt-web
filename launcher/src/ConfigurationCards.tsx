import { useId } from "react";
import type { CodexRepairPreview, Language } from "./types";

const copy = {
  en: {
    connection: ["Connection", "Where this Codex target sends requests. Native models selected inside this route also depend on the bridge."],
    subagents: ["Subagent behavior", "The protocol and feature choices for this target, including inherited settings."],
    interrupt: ["Interrupt cleanup", "Runs when you interrupt an active main-thread turn. It asks this runtime to clean up that exact turn; it does not run for every message."],
    catalog: ["Model catalog", "The model metadata used by this target."], runtime: ["Runtime", "Changes to the selected bridge runtime."], other: ["Additional findings", "Issues that need attention before applying this configuration."],
    current: "Current effective state", proposed: "After this change", ambiguous: "Competing or incomplete definitions — no effective value assumed", inactive: "Commented out (inactive)", missing: "Not set", inherited: "Inherited", unchanged: "Unchanged", blocked: "Not yet applicable",
    sources: "Source definitions", history: "Installation history", baseline: "Previously recorded value; not automatically the desired value", details: "Technical details", command: "Cleanup command", trust: "Trusted hook definition", timeout: "Cleanup timeout (seconds)", hash: "This hash identifies the approved hook definition, not the integrity of its executable.",
    choose: "Use this definition", resolve: "Choose the definition to keep. Competing active definitions will be commented out, not deleted.", target: "Target", base: "Base configuration (desktop-wide)", profile: "CLI profile", unclaimed: "Not claimed by this installation", tracked: "Tracked by this installation",
    approved: "An approved cleanup definition is recorded", approve: "Approve the proposed cleanup definition", execute: "Run this runtime’s Interrupt cleanup helper", exact: "Exact executable, arguments, or trust definition",
    consolidate: "Consolidate here", tables: "Choose the table to retain. Settings from the duplicate tables will be moved here; their original text will remain commented out. Array tables are not deduplicated.", selected: "Selected definition",
  },
  "zh-CN": {
    connection: ["连接", "此 Codex 目标发送请求的位置。通过该连接选择的原生模型也依赖桥接程序。"], subagents: ["子代理行为", "此目标的协议与功能选择，包括继承的设置。"],
    interrupt: ["中断清理", "中断主线程的活动任务时运行。它请求此运行时清理该任务，并非每条消息都会运行。"], catalog: ["模型目录", "此目标使用的模型元数据。"], runtime: ["运行时", "所选桥接运行时的更改。"], other: ["其他检查结果", "应用配置前需要处理的问题。"],
    current: "当前生效状态", proposed: "更改后", ambiguous: "存在冲突或不完整定义，无法确定生效值", inactive: "已注释（未启用）", missing: "未设置", inherited: "继承", unchanged: "不变", blocked: "尚无法应用",
    sources: "源定义", history: "安装记录", baseline: "之前记录的值，不一定是期望值", details: "技术详情", command: "清理命令", trust: "已信任的钩子定义", timeout: "清理超时（秒）", hash: "此哈希标识获准的钩子定义，而非可执行文件的完整性。",
    choose: "使用此定义", resolve: "选择保留的定义。其他活动定义将被注释，而非删除。", target: "目标", base: "基础配置（桌面范围）", profile: "CLI 配置档", unclaimed: "不属于此安装", tracked: "由此安装跟踪",
    approved: "已记录获准的清理定义", approve: "批准拟议的清理定义", execute: "运行此运行时的中断清理程序", exact: "准确的可执行文件、参数或信任定义",
    consolidate: "合并到此处", tables: "选择保留的表。重复表中的设置会移到此处，原始文本将被注释保留。不会去重数组表。", selected: "已选择的定义",
  },
  ja: {
    connection: ["接続", "この Codex 対象のリクエスト送信先です。この経路で選択したネイティブモデルもブリッジに依存します。"], subagents: ["サブエージェントの動作", "継承された設定を含む、この対象のプロトコルと機能の選択です。"],
    interrupt: ["中断時の後処理", "メインスレッドの実行中ターンを中断したときに実行します。そのターンの後処理を要求するもので、メッセージごとには実行しません。"], catalog: ["モデルカタログ", "この対象で使うモデルのメタデータです。"], runtime: ["ランタイム", "選択したブリッジランタイムの変更です。"], other: ["その他の確認結果", "設定を適用する前に対応が必要な問題です。"],
    current: "現在の有効な状態", proposed: "変更後", ambiguous: "競合または不完全な定義のため、有効値を仮定しません", inactive: "コメントアウト（無効）", missing: "未設定", inherited: "継承", unchanged: "変更なし", blocked: "まだ適用できません",
    sources: "設定の定義元", history: "インストール記録", baseline: "以前に記録された値であり、必ずしも望ましい値ではありません", details: "技術的な詳細", command: "後処理コマンド", trust: "信頼済みフックの定義", timeout: "後処理のタイムアウト（秒）", hash: "このハッシュは承認済みのフック定義を識別します。実行ファイルの完全性を証明するものではありません。",
    choose: "この定義を使用", resolve: "残す定義を選びます。競合する有効な定義は削除せずコメントアウトします。", target: "対象", base: "基本設定（デスクトップ全体）", profile: "CLI プロファイル", unclaimed: "このインストールの管理対象外", tracked: "このインストールが追跡",
    approved: "承認済みの後処理定義が記録されています", approve: "提案された後処理定義を承認", execute: "このランタイムの中断後処理を実行", exact: "正確な実行ファイル、引数、信頼定義",
    consolidate: "ここに統合", tables: "残すテーブルを選択します。重複したテーブルの設定をここに移動し、元のテキストをコメントとして残します。配列テーブルは統合しません。", selected: "選択済みの定義",
  },
} as const;

export function ConfigurationCards({ preview, language, selectOccurrence }: {
  preview: CodexRepairPreview;
  language: Language;
  selectOccurrence?: (id: string) => void;
}) {
  const labels = copy[language];
  const sectionHelp = language === "zh-CN" ? "选择保留的路由区段。只会移动路由设置；其他区段的标记和已移动文本将被注释保留。无关内容不会改变。" : language === "ja" ? "残す経路セクションを選択します。経路設定だけを移動し、他のマーカーと移動元のテキストはコメントとして保持します。無関係の内容は変更しません。" : "Choose the route section to retain. Only route settings move; other markers and moved source stay commented out. Unrelated contents remain unchanged.";
  const id = useId();
  const value = (item: unknown) => item == null ? labels.missing : String(item);
  return <div className="configuration-groups">
    {preview.additionalTargets?.map(related => <ConfigurationCards key={related.target.id} preview={{ ...preview, ...related, additionalTargets: undefined }} language={language} />)}
    {preview.target ? <p className="configuration-target"><strong>{labels.target}: {preview.target.kind === "profile" ? `${labels.profile} ${preview.target.profile}` : labels.base}</strong><code>{preview.target.configPath}</code></p> : null}
    {preview.groups?.map(group => <section className="configuration-group" key={group.id} aria-labelledby={`${id}-${group.id}`}>
      <h3 id={`${id}-${group.id}`}>{labels[group.id][0]}</h3><p>{labels[group.id][1]}</p>
      {group.settings.map(setting => {
        const hook = group.id === "interrupt";
        const trust = hook && setting.path.endsWith("trusted_hash");
        const command = hook && setting.path.endsWith("command");
        const name = command ? labels.command : trust ? labels.trust : hook && setting.path.endsWith("timeout") ? labels.timeout : setting.path;
        const display = (item: unknown, proposed = false) => item == null ? labels.missing : trust ? proposed && setting.current !== setting.proposed ? labels.approve : labels.approved : command ? labels.execute : value(item);
        return <article className="configuration-change-card" key={setting.path}>
          <h4>{name}</h4>
          <div className="configuration-value-pair"><section><h5>{labels.current}</h5>
            <p>{setting.state === "ambiguous" ? labels.ambiguous : setting.state === "commented_out" ? labels.inactive : <code>{display(setting.current)}</code>}</p>
            {setting.inherited ? <small>{labels.inherited}</small> : null}
          </section><section><h5>{labels.proposed}</h5><p>{preview.status !== "ready" ? labels.blocked : <><code>{display(setting.proposed, true)}</code>{setting.current === setting.proposed ? <small>{labels.unchanged}</small> : null}</>}</p></section></div>
          {trust ? <p>{labels.hash}</p> : null}
          {setting.findings.length ? <ul className="diagnostic-findings">{setting.findings.map((finding, index) => <li key={index}>{finding.message}</li>)}</ul> : null}
          {setting.occurrences.length ? <details open={setting.resolutionRequired || undefined} className="configuration-occurrences"><summary>{labels.sources} ({setting.occurrences.length})</summary>
            {setting.resolutionRequired ? <p>{setting.resolutionKind === "table" ? labels.tables : setting.resolutionKind === "route-section" ? sectionHelp : labels.resolve}</p> : null}
            <ul>{setting.occurrences.map(item => <li key={`${item.file}:${item.id}`}><code>{item.file}:{item.line}{item.endLine !== item.line ? `–${item.endLine}` : ""}</code>
              <p><code>{value(item.value)}</code></p><small>{item.state === "commented_out" ? labels.inactive : item.layer} · {item.ownership === "tracked" ? labels.tracked : labels.unclaimed}</small>
              {selectOccurrence && setting.resolutionRequired && item.file === preview.target?.configPath ? <button type="button" className="button-secondary" aria-pressed={preview.resolutions?.some(choice => choice.occurrenceId === item.id) === true} disabled={preview.refreshing} onClick={() => selectOccurrence(item.id)}>{preview.resolutions?.some(choice => choice.occurrenceId === item.id) ? labels.selected : setting.resolutionKind === "table" ? labels.consolidate : labels.choose}</button> : null}
            </li>)}</ul>
          </details> : null}
          {setting.baseline !== undefined ? <details><summary>{labels.history}</summary><p>{labels.baseline}</p><code>{value(setting.baseline)}</code></details> : null}
          {hook ? <details><summary>{labels.details}</summary><p>{labels.exact}</p><code>{setting.path}</code><p>{labels.current}: <code>{value(setting.current)}</code></p><p>{labels.proposed}: <code>{value(setting.proposed)}</code></p></details> : null}
        </article>;
      })}
    </section>)}
  </div>;
}
