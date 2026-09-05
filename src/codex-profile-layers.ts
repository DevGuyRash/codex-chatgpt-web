import { inspectCodexConfigSource } from "./codex-config-source";
import { parseTomlValue } from "./toml-edit";
import { CodexConfigurationError } from "./codex-configuration-error";

/** Profile hooks are additive. An inherited bridge hook cannot be replaced by a local copy. */
export function assertProfileBaseLayer(baseText: string, basePath: string): void {
  const source = inspectCodexConfigSource(baseText);
  if (source.conflicts.length) throw new CodexConfigurationError(source.conflicts.map(finding => ({ ...finding, path: `inherited.${finding.path}`, message: `${basePath}: ${finding.message}` })));
  const hooks = parseTomlValue(baseText).hooks;
  const groups = hooks && typeof hooks === "object" && !Array.isArray(hooks) ? (hooks as Record<string, unknown>).Interrupt : undefined;
  const scopedCleanup = Array.isArray(groups) && groups.some(group => {
    const commands = group && typeof group === "object" ? (group as { hooks?: unknown }).hooks : undefined;
    return Array.isArray(commands) && commands.some(hook => hook && typeof hook.command === "string" && /--home['"]?\s.+['"]?hook['"]?\s+['"]?interrupt['"]?\s*$/.test(hook.command));
  });
  if (source.sections.some(section => section.kind === "interrupt") || scopedCleanup) throw new CodexConfigurationError([{
    path: "hooks.Interrupt", category: "ownership_conflict",
    message: `${basePath}: this profile inherits a runtime-scoped Interrupt cleanup hook. Codex adds profile hooks to base hooks; it does not replace them. Review a base-to-profile migration or remove the base integration through its owner before installing another effective bridge hook.`,
  }]);
}
