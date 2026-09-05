import { createContext, useContext, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { Copy } from "./i18n";
import { ConfigurationRepair } from "./ConfigurationRepair";
import type { DiagnosticProblem, DoctorReport, Language, LauncherApi, LauncherState, RecoveryAction } from "./types";

export const RecoveryContext = createContext<(action: RecoveryAction) => void>(() => {});
export function ErrorToast({ copy, language, message, problem, disabled, onDismiss }: { copy: Copy; language: Language; message: string; problem?: DiagnosticProblem; disabled: boolean; onDismiss: () => void }) {
  const friendly = language === "zh-CN" ? ["操作未完成。请使用下方恢复操作查看下一步。", "技术详情"] : language === "ja" ? ["操作を完了できませんでした。下の復旧操作で次の手順を確認してください。", "技術的な詳細"] : ["The operation did not complete. Use the recovery action below to review the next step.", "Technical details"];
  return <motion.div role="alert" animate={{ opacity: 1, y: 0 }} className="error-toast" exit={{ opacity: 0, y: 8 }} initial={{ opacity: 0, y: 8 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
    <i aria-hidden="true" className="state-dot is-error" />
    <div><strong>{copy.error}</strong><p>{friendly[0]}</p><details><summary>{friendly[1]}</summary><p>{message}</p></details>
      {problem ? <ProblemFindings findings={problem.findings} /> : null}
      <RecoveryActions actions={problem?.actions ?? ["run-doctor", "export-logs"]} language={language} disabled={disabled} />
    </div>
    <button onClick={onDismiss} type="button">{copy.dismiss}</button>
  </motion.div>;
}
const actionLabels = {
  en: { "run-doctor": "Run Doctor", "review-configuration": "Review fix", "review-setup": "Review setup", "export-logs": "Export diagnostic logs", close: "Close", title: "Diagnostics and recovery", working: "Checking…" },
  "zh-CN": { "run-doctor": "运行诊断", "review-configuration": "审核修复", "review-setup": "查看设置", "export-logs": "导出诊断日志", close: "关闭", title: "诊断与恢复", working: "检查中…" },
  ja: { "run-doctor": "診断を実行", "review-configuration": "修復を確認", "review-setup": "セットアップを確認", "export-logs": "診断ログをエクスポート", close: "閉じる", title: "診断と復旧", working: "確認中…" },
};
export function RecoveryActions({ actions, language, disabled = false }: { actions: RecoveryAction[]; language: Language; disabled?: boolean }) {
  const recover = useContext(RecoveryContext);
  return <div className="recovery-actions">{actions.filter(action => Object.hasOwn(actionLabels.en, action)).map(action =>
    <button type="button" className="button-secondary" key={action} disabled={disabled} onClick={() => recover(action)}>{actionLabels[language][action]}</button>)}</div>;
}
export function ProblemFindings({ findings }: { findings: DiagnosticProblem["findings"] }) {
  return findings.length ? <ul className="diagnostic-findings">{findings.map((finding, index) => <li key={index}>
    {finding.path ? <code>{finding.path}</code> : null}<p>{finding.message}</p>
  </li>)}</ul> : null;
}
export function DiagnosticChecks({ report, language, disabled = false }: { report: DoctorReport; language: Language; disabled?: boolean }) {
  return <div className="diagnostic-checks">{report.checks.map(check => <section key={check.id} data-status={check.status}>
    <h4>{check.message}</h4>
    {check.findings?.length ? <ProblemFindings findings={check.findings} /> : check.detail ? <p className="diagnostic-detail">{check.detail}</p> : null}
    {check.problem ? <RecoveryActions actions={check.problem.actions} language={language} disabled={disabled} /> : null}
  </section>)}</div>;
}
export function RecoveryDialog({ action, api, language, devProfile, onClose, onRepaired }: {
  action: "run-doctor" | "review-configuration"; api: LauncherApi; language: Language; devProfile: boolean;
  onClose: () => void; onRepaired: (state: LauncherState) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(action === "run-doctor");
  const [error, setError] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [applied, setApplied] = useState(false);
  const outcome = language === "zh-CN" ? ["更改已应用", "需要重启", "连接已验证", "检查未完成。请查看技术详情，然后重新运行诊断。", "技术详情"] : language === "ja" ? ["変更を適用しました", "再起動が必要です", "接続を確認しました", "確認を完了できませんでした。技術的な詳細を確認し、診断を再実行してください。", "技術的な詳細"] : ["Changes applied", "Restart required", "Connection verified", "The check could not finish. Review the technical details, then run diagnostics again.", "Technical details"];
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    if (action !== "run-doctor") return;
    let current = true;
    void api.doctor().then(next => { if (current) setReport(next); }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [action, api]);
  const copy = actionLabels[language];
  return <dialog ref={dialog} className="configuration-review-dialog recovery-dialog" aria-label={copy.title} onCancel={event => { event.preventDefault(); if (!busy && !rechecking) onClose(); }}>
    <h2>{copy.title}</h2>
    {action === "run-doctor" ? <>{busy ? <p role="status">{copy.working}</p> : null}{report ? <DiagnosticChecks report={report} language={language} disabled={busy} /> : null}</>
      : !devProfile ? <ConfigurationRepair api={api} language={language} disabled={rechecking} onBusyChange={setBusy} onRepaired={state => {
        onRepaired(state); setApplied(true); setRechecking(true); setReport(null);
        void api.doctor().then(setReport).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setRechecking(false));
      }} onError={setError} /> : null}
    {applied ? <p role="status">{outcome[0]} · {outcome[1]}{report?.ok ? ` · ${outcome[2]}` : ""}</p> : null}
    {rechecking ? <p role="status">{copy.working}</p> : null}
    {action !== "run-doctor" && report ? <DiagnosticChecks report={report} language={language} disabled={busy || rechecking} /> : null}
    {error ? <><p role="alert">{outcome[3]}</p><details><summary>{outcome[4]}</summary><pre className="diagnostic-detail">{error}</pre></details></> : null}
    <button type="button" className="button-secondary" disabled={busy || rechecking} onClick={onClose}>{copy.close}</button>
  </dialog>;
}
