/** Layout vocabulary only; ownership is established by the installation journal. */
export const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
export const MANAGED_ROUTE_COMMENT = "# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.";
export const ROUTES_BEGIN = "# BEGIN codex-chatgpt-web: routes";
export const ROUTES_END = "# END codex-chatgpt-web: routes";
export const MANAGED_INTERRUPT_HOOK_START = "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END = "# End codex-chatgpt-web interrupt lifecycle hook.";
