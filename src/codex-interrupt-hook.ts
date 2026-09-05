import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import { parseTomlValue, removeTomlComments, removeTomlPath } from "./toml-edit";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  const groups = record(parseTomlValue(text).hooks)?.Interrupt;
  if (groups === undefined) return 0;
  if (!Array.isArray(groups)) throw new Error("Codex Interrupt hooks must be an array before integration setup");
  return groups.length;
}

function hasManagedMarkers(text: string): boolean {
  return removeTomlComments(text, [MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END]) !== text;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (hasManagedMarkers(text)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  // Appending array-table syntax is not valid for every existing TOML representation.
  // Prove the generated document before returning any proposed integration write.
  const installed = { command, groupIndex, stateKey, trustedHash, fragment };
  if (inspectCodexInterruptHook(parseTomlValue(`${text}${fragment}`), installed) !== "valid") {
    throw new Error("Codex interrupt lifecycle hook cannot be uniquely installed; inspect existing hooks before repair");
  }
  return {
    text: `${text}${fragment}`,
    installed,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** One semantic ownership rule shared by inspection and mutation preflight. */
export function inspectCodexInterruptHook(document: unknown, installed: InstalledCodexInterruptHook): "valid" | "identity" | "order" {
  const hooks = record(record(document)?.hooks);
  const groups = hooks?.Interrupt;
  if (!Array.isArray(groups) || codexInterruptHookHash(installed.command) !== installed.trustedHash) return "identity";
  const occurrences = groups.flatMap((group, index) => {
    const entries = record(group)?.hooks;
    return Array.isArray(entries) ? entries.filter(entry => record(entry)?.command === installed.command).map(() => index) : [];
  });
  if (occurrences.length !== 1) return "identity";
  if (occurrences[0] !== installed.groupIndex) return "order";
  const group = record(groups[installed.groupIndex]);
  const entries = group?.hooks;
  if (!group || !Array.isArray(entries)) return "identity";
  const normalized = { ...group, hooks: entries.map(entry => {
    const hook = record(entry);
    return hook ? { ...hook, async: hook.async ?? false } : entry;
  }) };
  const expected = { hooks: [{ type: "command", command: installed.command, timeout: 3, async: false }] };
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
  return same(normalized, expected) && same(record(hooks?.state)?.[installed.stateKey], { trusted_hash: installed.trustedHash }) ? "valid" : "identity";
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  let document: unknown;
  try { document = parseTomlValue(text); }
  catch { throw new Error("Codex interrupt lifecycle hook changed after setup; configuration is invalid"); }
  const result = inspectCodexInterruptHook(document, installed);
  if (result === "order") throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  if (result !== "valid") throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
}

export function restoreCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): string {
  verifyCodexInterruptHook(text, installed);
  const groups = record(parseTomlValue(text).hooks)?.Interrupt;
  if (!Array.isArray(groups) || installed.groupIndex !== groups.length - 1) {
    throw new Error("Cannot remove the managed Interrupt hook without shifting later user hook identities; review those hooks first");
  }
  const removed = removeTomlComments(removeTomlPath(removeTomlPath(text,
    ["hooks", "Interrupt", installed.groupIndex]), ["hooks", "state", installed.stateKey]),
  [MANAGED_INTERRUPT_HOOK_START, MANAGED_INTERRUPT_HOOK_END]);
  // Retain exact historical formatting only if the byte replacement has the same
  // meaning as the syntax-owned removal. A lookalike fragment may be string content.
  if (text.includes(installed.fragment)) {
    const exact = text.replace(installed.fragment, "");
    try {
      if (isDeepStrictEqual(parseTomlValue(exact), parseTomlValue(removed))) return exact;
    } catch { /* Use the already verified syntax edit. */ }
  }
  return removed;
}

export function verifyCodexInterruptHookRestored(text: string, installed?: InstalledCodexInterruptHook): void {
  const groups = record(parseTomlValue(text).hooks)?.Interrupt;
  const commandPresent = installed && Array.isArray(groups) && groups.some(group => {
    const hooks = record(group)?.hooks;
    return Array.isArray(hooks) && hooks.some(hook => record(hook)?.command === installed.command);
  });
  if (hasManagedMarkers(text) || commandPresent) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
