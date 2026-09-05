import { createContext, useContext, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { Copy } from "./i18n";
import { ConfigurationRepair } from "./ConfigurationRepair";
import type { DiagnosticProblem, DoctorReport, Language, LauncherApi, LauncherState, RecoveryAction } from "./types";

export const RecoveryContext = createContext<(action: RecoveryAction) => void>(() => {});
export function ErrorToast({ copy, language, message, problem, disabled, onDismiss }: { copy: Copy; language: Language; message: string; problem?: DiagnosticProblem; disabled: boolean; onDismiss: () => void }) {
  return <motion.div role="alert" animate={{ opacity: 1, y: 0 }} className="error-toast" exit={{ opacity: 0, y: 8 }} initial={{ opacity: 0, y: 8 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
    <i aria-hidden="true" className="state-dot is-error" />
    <div><strong>{copy.error}</strong><p>{message}</p>
      {problem ? <ProblemFindings findings={problem.findings} /> : null}
      <RecoveryActions actions={problem?.actions ?? ["run-doctor", "export-logs"]} language={language} disabled={disabled} />
    </div>
    <button onClick={onDismiss} type="button">{copy.dismiss}</button>
  </motion.div>;
}
const actionLabels = {
  en: { "run-doctor": "Run Doctor", "review-configuration": "Review configuration repair", "review-setup": "Review setup", "export-logs": "Export diagnostic logs", close: "Close", title: "Diagnostics and recovery", working: "Checking…" },
  "zh-CN": { "run-doctor": "运行诊断", "review-configuration": "查看配置修复", "review-setup": "查看设置", "export-logs": "导出诊断日志", close: "关闭", title: "诊断与恢复", working: "检查中…" },
  ja: { "run-doctor": "診断を実行", "review-configuration": "設定の修復を確認", "review-setup": "セットアップを確認", "export-logs": "診断ログをエクスポート", close: "閉じる", title: "診断と復旧", working: "確認中…" },
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
  useEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  useEffect(() => {
    if (action !== "run-doctor") return;
    let current = true;
    void api.doctor().then(next => { if (current) setReport(next); }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [action, api]);
  const copy = actionLabels[language];
  return <dialog ref={dialog} className="configuration-review-dialog recovery-dialog" aria-label={copy.title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{copy.title}</h2>
    {action === "run-doctor" ? <>{busy ? <p role="status">{copy.working}</p> : null}{report ? <DiagnosticChecks report={report} language={language} disabled={busy} /> : null}</>
      : !devProfile ? <ConfigurationRepair api={api} language={language} disabled={false} onBusyChange={setBusy} onRepaired={onRepaired} onError={setError} /> : null}
    {error ? <p role="alert" className="diagnostic-detail">{error}</p> : null}
    <button type="button" className="button-secondary" disabled={busy} onClick={onClose}>{copy.close}</button>
  </dialog>;
}
