import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export function NoticeRow({ children, icon, tone, action }: { children: ReactNode; icon: IconName; tone: "warning" | "success"; action?: ReactNode }) {
  return <div className={`notice-row tone-${tone}`}>
    <Icon name={icon} /><span>{children}</span>
    {action ? <div className="notice-row-action">{action}</div> : null}
  </div>;
}
