import { actionErrorMessage } from "./actions/api";
import { useEffect, useState } from "react";
import type { Language, LauncherApi } from "./types";

const text = {
  en: { title: "Integration targets", body: "Each CLI profile has its own window, runtime, endpoint, catalog, and browser sign-in. Opening another target leaves this runtime running.", base: "Base configuration · desktop-wide route", current: "Current target", select: "Existing target", open: "Open target window", home: "Codex home", name: "New or existing profile name", create: "Open profile window", check: "Check Codex binary capabilities", checkBody: "Uses disposable offline fixtures. No model messages are sent and no browser sign-in is copied.", command: "Launch this Codex target", commandBody: "Start its bridge runtime first. This command does not replace your codex wrapper.", pending: "Checking…", refresh: "Refresh targets", opened: "The target window has been opened or focused.", verified: "Profile capability checks passed.", desktop: "The base target remains a supported desktop-wide route. Sessions using it depend on the bridge, including native-model passthrough." },
  "zh-CN": { title: "集成目标", body: "每个 CLI 配置档都有独立的窗口、运行时、端点、模型目录和浏览器登录。打开其他目标不会停止此运行时。", base: "基础配置 · 桌面范围连接", current: "当前目标", select: "现有目标", open: "打开目标窗口", home: "Codex 主目录", name: "新的或现有的配置档名称", create: "打开配置档窗口", check: "检查 Codex 可执行文件能力", checkBody: "使用临时离线测试配置。不会发送模型消息或复制浏览器登录。", command: "启动此 Codex 目标", commandBody: "请先启动其桥接运行时。此命令不会替换您的 codex 包装脚本。", pending: "正在检查…", refresh: "刷新目标", opened: "已打开或聚焦目标窗口。", verified: "配置档能力检查已通过。", desktop: "仍支持基础目标的桌面范围连接。使用该连接的会话（包括原生模型转发）依赖桥接程序。" },
  ja: { title: "統合対象", body: "CLI プロファイルごとにウィンドウ、ランタイム、接続先、カタログ、ブラウザーログインを分離します。他の対象を開いても現在のランタイムは停止しません。", base: "基本設定 · デスクトップ全体の接続", current: "現在の対象", select: "既存の対象", open: "対象のウィンドウを開く", home: "Codex ホーム", name: "新規または既存のプロファイル名", create: "プロファイルを開く", check: "Codex バイナリの機能を確認", checkBody: "一時的なオフライン設定で検証します。モデルメッセージの送信やブラウザーログインのコピーは行いません。", command: "この Codex 対象を起動", commandBody: "先にブリッジランタイムを起動してください。既存の codex ラッパーは置き換えません。", pending: "確認中…", refresh: "対象を更新", opened: "対象のウィンドウを開くかフォーカスしました。", verified: "プロファイルの機能検証に合格しました。", desktop: "基本対象ではデスクトップ全体の接続を引き続きサポートします。ネイティブモデルの転送を含め、この接続を使うセッションはブリッジに依存します。" },
};

export function IntegrationTargets({ api, language, disabled }: { api: Pick<LauncherApi, "integrationTargets" | "openIntegrationTarget" | "checkTargetCapabilities" | "setupCore"> & Partial<Pick<LauncherApi, "chooseCodexHome">>; language: Language; disabled: boolean }) {
  const copy = text[language];
  const guidance = language === "zh-CN" ? { title: "Codex 连接", body: "大多数用户只需要现有连接。", advanced: "高级：独立的命令行配置档", elsewhere: "由其他位置管理", unavailable: "不可用", details: "技术详情", error: "无法完成连接检查。刷新以重试；现有连接不会被更改。", create: "创建独立的命令行连接", home: "高级目录选项", review: "打开后，请检查能力并审核安装更改。此操作不会安装配置。" } : language === "ja" ? { title: "Codex 接続", body: "通常は既存の接続だけで十分です。", advanced: "詳細設定：独立した CLI プロファイル", elsewhere: "別の場所で管理", unavailable: "利用できません", details: "技術的な詳細", error: "接続の確認を完了できませんでした。更新して再試行してください。既存の接続は変更されません。", create: "独立した CLI 接続を作成", home: "ディレクトリの詳細設定", review: "開いた後、機能を確認してインストールの変更をレビューしてください。この操作では設定をインストールしません。" } : { title: "Codex connection", body: "Most users need only their existing connection.", advanced: "Advanced: separate command-line profiles", elsewhere: "Managed elsewhere", unavailable: "Unavailable", details: "Technical details", error: "The connection check could not finish. Refresh to try again; your existing connection has not been changed.", create: "Create a separate command-line connection", home: "Advanced directory options", review: "After opening, check capabilities and review the installation changes. Opening a window does not install configuration." };
  const suggestedName = (result: Awaited<ReturnType<LauncherApi["integrationTargets"]>>) => {
    const names = new Set((result.discovery?.entries ?? result.targets).map(target => target.profile));
    let name = "chatgpt-web", suffix = 2;
    while (names.has(name)) name = `chatgpt-web-${suffix++}`;
    return name;
  };
  const migration = language === "zh-CN" ? ["审核基础配置迁移", "先退出基础目标的启动器并停止其服务。审核将显示两个目标的更改；批准前不会迁移，也不会复制浏览器登录。"] : language === "ja" ? ["基本設定からの移行を確認", "基本対象のランチャーを終了しサービスを停止してください。両方の対象の変更を確認できます。承認前には移行せず、ブラウザーのログインもコピーしません。"] : ["Review base-to-profile migration", "Quit the base target's launcher and stop its service first. Review shows changes to both targets; nothing migrates before approval and no browser sign-in is copied."];
  const [data, setData] = useState<Awaited<ReturnType<LauncherApi["integrationTargets"]>> | null>(null);
  const [selected, setSelected] = useState("");
  const [home, setHome] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const refresh = async () => {
    const result = await api.integrationTargets();
    setData(result); setSelected(result.selected.id); setHome(result.selected.codexHome); setName(suggestedName(result));
  };
  useEffect(() => { let mounted = true; void api.integrationTargets().then(result => {
    if (mounted) { setData(result); setSelected(result.selected.id); setHome(result.selected.codexHome); setName(suggestedName(result)); }
  }, cause => { if (mounted) setError(actionErrorMessage(cause)); }); return () => { mounted = false; }; }, [api]);
  const perform = async (operation: () => Promise<void>) => {
    if (disabled || busy) return;
    const invokingControl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (cause) { setError(actionErrorMessage(cause)); } finally {
      setBusy(false);
      requestAnimationFrame(() => { if (invokingControl?.isConnected) invokingControl.focus(); });
    }
  };
  return <section className="configuration-repair integration-targets" aria-busy={busy}>
    <h3>{guidance.title}</h3><p>{guidance.body}</p>
    {data ? <>
      <p>{copy.current}: <strong>{data.selected.profile ?? copy.base}</strong><br /><code>{data.selected.configPath}</code></p>
      {data.selected.kind === "base" ? <p>{copy.desktop}</p> : null}
    </> : null}
    <details><summary>{guidance.advanced}</summary><p>{copy.body}</p>
    {data ? <>
      <label>{copy.select}<select value={selected} disabled={disabled || busy} onChange={event => setSelected(event.target.value)}>
        {data.targets.map(target => <option key={target.id} value={target.id}>{target.profile ?? copy.base}</option>)}
      </select></label>
      <div className="repair-actions"><button type="button" className="button-secondary" disabled={disabled || busy || !selected} onClick={() => void perform(async () => {
        const target = data.targets.find(target => target.id === selected)!;
        await api.openIntegrationTarget({ codexHome: target.codexHome, profile: target.profile }); setMessage(copy.opened);
      })}>{copy.open}</button><button type="button" className="button-secondary" disabled={disabled || busy} onClick={() => void perform(refresh)}>{copy.refresh}</button></div>
    </> : null}
    {data?.discovery?.entries.filter(entry => entry.status !== "available").map(entry => <details key={entry.id}><summary>{entry.profile ?? copy.base} · {entry.status === "external" ? guidance.elsewhere : guidance.unavailable}</summary><code>{entry.configPath}</code>{entry.resolvedPath ? <p><code>{entry.resolvedPath}</code></p> : null}</details>)}
    <details><summary>{guidance.create}</summary><p>{guidance.review}</p>
      <details><summary>{guidance.home}</summary><label>{copy.home}<input value={home} disabled={disabled || busy} onChange={event => setHome(event.target.value)} /></label>{api.chooseCodexHome ? <button className="button-secondary" disabled={disabled || busy} onClick={() => void perform(async () => { const path = await api.chooseCodexHome!(); if (path) setHome(path); })}>{language === "en" ? "Choose folder" : language === "ja" ? "フォルダーを選択" : "选择文件夹"}</button> : null}</details>
      <label>{copy.name}<input value={name} maxLength={64} disabled={disabled || busy} onChange={event => setName(event.target.value)} /></label>
      <button type="button" className="button-secondary" disabled={disabled || busy || !home.trim() || !/^[A-Za-z0-9_-]{1,64}$/.test(name)} onClick={() => void perform(async () => { await api.openIntegrationTarget({ codexHome: home.trim(), profile: name }); setMessage(copy.opened); })}>{copy.create}</button>
    </details>
    {data?.selected.kind === "profile" ? <><p>{copy.checkBody}</p><button type="button" className="button-secondary" disabled={disabled || busy} onClick={() => void perform(async () => {
      const result = await api.checkTargetCapabilities(); if (!result.cancelled) { await refresh(); setMessage(copy.verified); }
    })}>{busy ? copy.pending : copy.check}</button>{data.capabilityError ? <p>{data.capabilityError}</p> : null}</> : null}
    {data?.launchCommand ? <details><summary>{copy.command}</summary><p>{copy.commandBody}</p><pre>{data.launchCommand}</pre></details> : null}
    {data?.selected.kind === "profile" ? <details><summary>{migration[0]}</summary><p>{migration[1]}</p><button type="button" className="button-secondary" disabled={disabled || busy || Boolean(data.capabilityError)} onClick={() => void perform(async () => { await api.setupCore({ migrateBase: true }); await refresh(); })}>{migration[0]}</button></details> : null}
    </details>
    {message ? <p role="status">{message}</p> : null}{error || data?.inspectionError || data?.discovery?.issues.length ? <><p role="alert">{guidance.error}</p><details><summary>{guidance.details}</summary><pre>{error || data?.inspectionError || data?.discovery?.issues.map(issue => `${issue.code}: ${issue.path ?? ""}`).join("\n")}</pre></details></> : null}
  </section>;
}
