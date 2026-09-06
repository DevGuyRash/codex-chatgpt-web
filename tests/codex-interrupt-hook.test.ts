import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MANAGED_INTERRUPT_HOOK_END,
  codexInterruptHookCommand,
  codexInterruptHookHash,
  installCodexInterruptHook,
  restoreCodexInterruptHook,
  verifyCodexInterruptHook,
  verifyCodexInterruptHookRestored,
} from "../src/codex-interrupt-hook";

test("semantic hook removal preserves native TOML tables inserted before a trailing marker", () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const original = 'model = "gpt-5.6-sol"\n';
    const installed = installCodexInterruptHook(original.replaceAll("\n", ending), "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
    const appended = "\n[features]\ngoals = true\n";
    const edited = installed.text.replace(/\r\n|\r/g, "\n").replace(MANAGED_INTERRUPT_HOOK_END, appended + MANAGED_INTERRUPT_HOOK_END);
    verifyCodexInterruptHook(edited, installed.installed);
    const restored = restoreCodexInterruptHook(edited, installed.installed);
    expect(Bun.TOML.parse(restored)).toEqual({ model: "gpt-5.6-sol", features: { goals: true } });
    expect(restored).toContain(appended);
    verifyCodexInterruptHookRestored(restored);
    expect(() => restoreCodexInterruptHook(edited.replace("timeout = 3", "timeout = 2"), installed.installed)).toThrow();
  }
});

test("installs one narrowly trusted Interrupt hook and restores the exact Codex config", () => {
  const original = [
    'model = "gpt-5.6-sol"',
    "",
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "existing-hook"',
    "",
  ].join("\n");
  const config = { runtimeCommand: ["/opt/Codex Web/runtime/bun", "/opt/Codex Web/app/cli.js"] };
  const installed = installCodexInterruptHook(original, "/Users/test/.codex/config.toml", config);

  expect(installed.installed.groupIndex).toBe(1);
  expect(installed.installed.stateKey).toBe(`${resolve("/Users/test/.codex/config.toml")}:interrupt:1:0`);
  expect(installed.text).toContain('[[hooks.Interrupt]]');
  expect(installed.text).toContain(`[hooks.state.${JSON.stringify(installed.installed.stateKey)}]`);
  expect(installed.text).toContain(`trusted_hash = ${JSON.stringify(installed.installed.trustedHash)}`);
  verifyCodexInterruptHook(installed.text, installed.installed);
  expect(restoreCodexInterruptHook(installed.text, installed.installed)).toBe(original);
  verifyCodexInterruptHookRestored(original);
});

test("trusts the canonical Codex config path before a new config file exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-interrupt-hook-"));
  try {
    const configPath = join(directory, "config.toml");
    const installed = installCodexInterruptHook("", configPath, { runtimeCommand: ["/opt/runtime"] });
    expect(installed.installed.stateKey).toBe(
      `${join(realpathSync.native(directory), "config.toml")}:interrupt:0:0`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Interrupt hook command is absolute, quoted, and bound to the exact application home", () => {
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["/Applications/Codex Web GPT.app/runtime/bun", "/Applications/Codex Web GPT.app/app/cli.js"] },
    "/Users/test/Application Support/Codex Web GPT",
    "darwin",
  )).toBe(
    "'/Applications/Codex Web GPT.app/runtime/bun' '/Applications/Codex Web GPT.app/app/cli.js'"
      + " '--home' '/Users/test/Application Support/Codex Web GPT' 'hook' 'interrupt'",
  );
  expect(codexInterruptHookCommand(
    { runtimeCommand: ["C:\\Program Files\\Codex Web GPT\\bun.exe", "C:\\Program Files\\Codex Web GPT\\cli.js"] },
    "C:\\Users\\test\\Codex Web GPT",
    "win32",
  )).toBe(
    '"C:\\Program Files\\Codex Web GPT\\bun.exe" "C:\\Program Files\\Codex Web GPT\\cli.js"'
      + ' "--home" "C:\\Users\\test\\Codex Web GPT" "hook" "interrupt"',
  );
});

test("Interrupt hook trust hash is deterministic and changes with its exact command", () => {
  const first = codexInterruptHookHash("'runtime' 'hook' 'interrupt'");
  expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(codexInterruptHookHash("'runtime' 'hook' 'interrupt'")).toBe(first);
  expect(codexInterruptHookHash("'other-runtime' 'hook' 'interrupt'")).not.toBe(first);
});

test("refuses to remove a modified or duplicated managed hook", () => {
  const original = 'model = "gpt-5.6-sol"\n';
  const installed = installCodexInterruptHook(
    original,
    "/Users/test/.codex/config.toml",
    { runtimeCommand: ["/opt/runtime"] },
  );
  const modified = installed.text.replace("timeout = 3", "timeout = 2");
  expect(() => restoreCodexInterruptHook(modified, installed.installed)).toThrow("changed after setup");
  const reordered = [
    "[[hooks.Interrupt]]",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    'command = "new-earlier-hook"',
    "",
    installed.text,
  ].join("\n");
  expect(() => restoreCodexInterruptHook(reordered, installed.installed)).toThrow("order changed after setup");
  expect(() => installCodexInterruptHook(installed.text, "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] }))
    .toThrow("already contains");
});

test("verifies a semantically unchanged hook after formatting without trusting markers", () => {
  const installed = installCodexInterruptHook('model = "keep"\n', "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  const formatted = installed.text.replaceAll(" = ", "    = ").replace(/# Managed by[^\n]*/g, "");
  expect(() => verifyCodexInterruptHook(formatted, installed.installed)).not.toThrow();
});

test("removes only the owned hook and trust record from an inline representation", () => {
  const { installed } = installCodexInterruptHook('', "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  const text = `model = "keep"\nhooks = { Interrupt = [{ hooks = [{ command = ${JSON.stringify(installed.command)}, type = "command", timeout = 3 }] }], state = { ${JSON.stringify(installed.stateKey)} = { trusted_hash = ${JSON.stringify(installed.trustedHash)} }, other = { trusted_hash = "keep" } } }\n`;
  const restored = restoreCodexInterruptHook(text, installed);
  expect(Bun.TOML.parse(restored)).toEqual({ model: "keep", hooks: { Interrupt: [], state: { other: { trusted_hash: "keep" } } } });
});

test("removal refuses to shift later user hook trust identities", () => {
  const installed = installCodexInterruptHook('', "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  const text = installed.text + '\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype="command"\ncommand="later-user-hook"\n';
  expect(() => restoreCodexInterruptHook(text, installed.installed)).toThrow("later");
});

test("hook-like content inside a multiline note is never removed", () => {
  const installed = installCodexInterruptHook('', "/Users/test/.codex/config.toml", { runtimeCommand: ["/opt/runtime"] });
  const note = `note = '''${installed.installed.fragment}'''\n`;
  const formatted = installed.text.replaceAll(" = ", "   = ");
  const restored = restoreCodexInterruptHook(note + formatted, installed.installed);
  expect(restored).toContain(note);
  expect(() => verifyCodexInterruptHookRestored(restored)).not.toThrow();
});

test("setup refuses to duplicate an unmarked owned command", () => {
  const config = { runtimeCommand: ["/opt/runtime"] };
  const installed = installCodexInterruptHook('', "/Users/test/.codex/config.toml", config);
  const unmarked = installed.text.replace(/^#.*$/gm, "");
  expect(() => installCodexInterruptHook(unmarked, "/Users/test/.codex/config.toml", config)).toThrow("uniquely");
});
