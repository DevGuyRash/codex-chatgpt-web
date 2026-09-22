import type { ActionNotice } from "./controller";

const routine = new Set(["refresh", "search", "more", "group", "openExternal", "openSocial", "openIntegrationTarget", "chooseCodexHome"]);
export function noticePolicy(notice: ActionNotice) {
  const category = /copy|export/i.test(notice.key) ? "report" : /setup|install|config|repair|restart/i.test(notice.key) ? "setup"
    : /runtime|bridge|tunnel|browser/i.test(notice.key) ? "connection" : "action";
  const severity = notice.status === "failed" ? "error" : notice.status === "succeeded" ? "success" : "info";
  const component = notice.problem?.origin ?? "launcher";
  const quiet = routine.has(notice.key) && notice.status !== "failed";
  const timeout = notice.status === "succeeded" ? 5000 : notice.status === "cancelled" ? 3000 : undefined;
  return { category, severity, component, quiet, timeout } as const;
}

export function noticeGroupKey(notice: ActionNotice): string {
  // Generic failures cannot be assumed equivalent across different operations.
  const identity = notice.problem?.code === "operation_failed" ? notice.traceId ?? notice.id : notice.problem?.code ?? notice.errorCode ?? "";
  return JSON.stringify([notice.key, notice.scope ?? "", notice.status, identity, notice.problem?.stage ?? ""]);
}
export type NoticeGroup = { notice: ActionNotice; ids: string[]; count: number; firstAt: number; latestAt: number };
export function groupNotices(notices: readonly ActionNotice[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    if (noticePolicy(notice).quiet) continue;
    const key = noticeGroupKey(notice), at = notice.updatedAt ?? notice.startedAt ?? 0;
    const previous = groups.get(key);
    if (previous) { previous.ids.push(notice.id); previous.count++; previous.firstAt = Math.min(previous.firstAt, notice.startedAt ?? at); previous.latestAt = Math.max(previous.latestAt, at); }
    else groups.set(key, { notice, ids: [notice.id], count: 1, firstAt: notice.startedAt ?? at, latestAt: at });
  }
  return [...groups.values()];
}
