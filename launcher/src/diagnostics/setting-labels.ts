import type { Language } from "../types";
const names: Record<string, readonly [string, string, string]> = {
  "runtime.releaseVersion": ["Runtime version", "运行时版本", "ランタイムのバージョン"],
  "runtime.subagentProtocol": ["Subagent protocol", "子代理协议", "サブエージェントのプロトコル"],
  "runtime.appName": ["Connector name", "连接器名称", "コネクター名"],
  "runtime.mode": ["Runtime mode", "运行时模式", "ランタイムモード"],
  "runtime.browserInteractionMode": ["Browser interaction", "浏览器交互", "ブラウザ操作"],
  "features.multi_agent_v2.enabled": ["Native V2", "原生 V2", "ネイティブ V2"],
  "features.multi_agent": ["Subagents", "子代理", "サブエージェント"],
  "agents.max_depth": ["Maximum subagent depth", "子代理最大深度", "サブエージェントの最大深度"],
  "agents.max_threads": ["Maximum concurrent subagents", "最大并发子代理数", "サブエージェントの最大同時数"],
  "openai_base_url": ["API connection address", "API 连接地址", "API 接続先"],
  "experimental_realtime_webrtc_call_base_url": ["Realtime connection address", "实时连接地址", "リアルタイム接続先"],
};
export function settingLabel(path: string, language: Language, fallback: string): string {
  const localized = names[path];
  if (localized) return localized[language === "en" ? 0 : language === "zh-CN" ? 1 : 2];
  if (/^hooks\.[^.]+$/.test(path)) return path.slice("hooks.".length).replace(/([a-z])([A-Z])/g, "$1 $2");
  if (path.startsWith("features.") || path.startsWith("agents.") || path.startsWith("runtime.")) return path.split(".").slice(1).join(" · ").replaceAll("_", " ");
  return fallback;
}
export function integrationSummary(value: unknown, language: Language): string {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) {
      const count = parsed.reduce((sum, item) => sum + (item && Array.isArray(item.hooks) ? item.hooks.length : 1), 0);
      return language === "en" ? `${count} external hook${count === 1 ? "" : "s"}; definitions preserved` : language === "zh-CN" ? `${count} 个外部钩子；保留原有定义` : `${count} 件の外部フック（定義を保持）`;
    }
  } catch { /* Exact values remain available in technical details. */ }
  return language === "en" ? "External definition preserved" : language === "zh-CN" ? "保留外部定义" : "外部定義を保持";
}
