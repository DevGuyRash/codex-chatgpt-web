import type { Language } from "../types";
import { diagnosticRequestMessages, type DiagnosticRequestCode } from "../../../src/diagnostics/request-error";

export const diagnosticErrors: Record<Language, Record<DiagnosticRequestCode, string>> = {
  en: diagnosticRequestMessages,
  "zh-CN": {
    recovery_unavailable: "保留的记录不足以还原原始设置选项。请打开设置流程，审核所需连接；尚未开始更改设置。",
    cancelled: "诊断请求已取消", timeout: "诊断搜索超时。请缩小范围后重试。", invalid_query: "搜索无效。请检查正则表达式和筛选条件。", query_failed: "诊断查询未完成。请检查采集状态后重试。", busy: "诊断正忙。请等待当前请求完成。", unavailable: "诊断存储不可用。请检查权限、可用空间和组件版本。", export_failed: "无法保存报告。请检查目标位置和可用空间。", capture_failed: "无法更改捕获设置。仍显示上次已知状态。", clear_failed: "无法删除诊断记录。请检查采集状态。",
  },
  ja: {
    recovery_unavailable: "保存された記録から元の設定内容を復元できません。セットアップを開いて対象の接続を確認してください。設定変更は開始していません。",
    cancelled: "診断リクエストをキャンセルしました", timeout: "診断検索が時間切れになりました。条件を絞って再試行してください。", invalid_query: "検索が無効です。正規表現と条件を確認してください。", query_failed: "診断検索を完了できませんでした。収集状態を確認して再試行してください。", busy: "診断は処理中です。現在のリクエストの完了を待ってください。", unavailable: "診断ストレージを利用できません。権限、空き容量、バージョンを確認してください。", export_failed: "レポートを保存できませんでした。保存先と空き容量を確認してください。", capture_failed: "記録設定を変更できませんでした。最後の既知の状態を表示しています。", clear_failed: "診断記録を削除できませんでした。収集状態を確認してください。",
  },
};
