import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { getCodexJournalPath, getCodexJournalRecoveryPath, installCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

test("inspection distinguishes a disabled route from an absent assignment", () => {
  const { configPath, text } = fixture();
  const edited = text.replace(/^openai_base_url\s*=/m, "# openai_base_url =");
  writeFileSync(configPath, edited);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toMatchObject([
    { path: "openai_base_url", category: "commented_out", current: null },
  ]);
  expect(readFileSync(configPath, "utf8")).toBe(edited);
});

test("inspection does not mistake a multiline string for a disabled route", () => {
  const { configPath, text } = fixture();
  const edited = 'example = """\n# openai_base_url = "example"\n"""\n' + text.replace(/^openai_base_url\s*=.*\n/m, "");
  writeFileSync(configPath, edited);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toMatchObject([
    { path: "openai_base_url", category: "missing" },
  ]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-inspection-"));
  for (const [key, value] of Object.entries({ CODEX_HOME: join(root, "codex"), CODEX_CHATGPT_WEB_HOME: join(root, "app") })) {
    const previous = process.env[key];
    process.env[key] = value;
    cleanups.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "codex"));
  const configPath = join(root, "codex", "config.toml");
  writeFileSync(configPath, '[features]\nmulti_agent = true\n[features.multi_agent_v2]\nenabled = true\n');
  const journal = installCodexIntegration(defaultConfig("browser-only"));
  return { configPath, journal, text: readFileSync(configPath, "utf8") };
}

test("read-only inspection accepts equivalent formatting without restoring managed comments", () => {
  const { configPath, text } = fixture();
  const formatted = text.replaceAll(" = ", "          = ").replace(/# (?:Managed by[^\r\n]*|End codex-chatgpt-web interrupt lifecycle hook\.)/g, "");
  writeFileSync(configPath, formatted);
  const result = inspectCodexIntegration({ readOnly: true });
  expect(result.errors).toEqual([]);
  expect(result.conflicts).toEqual([]);
  expect(readFileSync(configPath, "utf8")).toBe(formatted);
});

test("read-only inspection reports all real setting conflicts instead of only the first", () => {
  const { configPath, text } = fixture();
  const edited = text.replace("multi_agent = true", "multi_agent = false")
    .replace("enabled = false", "enabled = true").replace("max_depth = 2", "max_depth = 4");
  writeFileSync(configPath, edited);
  const result = inspectCodexIntegration({ readOnly: true });
  expect(result.conflicts.map(conflict => conflict.path)).toEqual([
    "features.multi_agent", "features.multi_agent_v2.enabled", "agents.max_depth",
  ]);
  expect(result.conflicts[1]).toMatchObject({ category: "value_changed", expected: false, current: true });
  expect(result.errors).toHaveLength(3);
  expect(readFileSync(configPath, "utf8")).toBe(edited);
});

test("read-only inspection can use recovery evidence without writing a missing primary journal", () => {
  const { configPath, text } = fixture();
  const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");
  writeFileSync(configPath, text.replaceAll(" = ", "   = "));
  rmSync(getCodexJournalPath());
  expect(inspectCodexIntegration({ readOnly: true }).errors).toEqual([]);
  expect(existsSync(getCodexJournalPath())).toBe(false);
  expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(recovery);
});

test("read-only inspection accepts equivalent inline hook groups and structured feature syntax", () => {
  const { configPath, journal, text } = fixture();
  const hook = journal.interruptHook;
  const inline = `hooks = { Interrupt = [{ hooks = [{ type = "command", command = ${JSON.stringify(hook.command)}, timeout = 3, async = false }] }], state = { ${JSON.stringify(hook.stateKey)} = { trusted_hash = ${JSON.stringify(hook.trustedHash)} } } }\n`;
  const formatted = inline + text.replace(hook.fragment, "")
    .replace(/\[features\.multi_agent_v2\]\r?\nenabled = false[^\r\n]*/, "multi_agent_v2 = { enabled = false }");
  writeFileSync(configPath, formatted);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  expect(readFileSync(configPath, "utf8")).toBe(formatted);
});

test("read-only inspection refuses duplicate owned hooks even when the original remains in place", () => {
  const { configPath, journal, text } = fixture();
  const duplicate = `\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(journal.interruptHook.command)}\ntimeout = 3\n`;
  writeFileSync(configPath, text + duplicate);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toMatchObject([{ category: "hook_changed" }]);
});

test("read-only inspection leaves disagreeing journal copies untouched", () => {
  fixture();
  const path = getCodexJournalRecoveryPath();
  const recovery = JSON.parse(readFileSync(path, "utf8"));
  recovery.previous.model_provider = { present: false, rawLine: "different ownership baseline" };
  const edited = JSON.stringify(recovery);
  writeFileSync(path, edited);
  expect(() => inspectCodexIntegration({ readOnly: true })).toThrow("different baselines");
  expect(readFileSync(path, "utf8")).toBe(edited);
});

test("read-only inspection rejects ambiguous or malformed TOML without leaking its contents", () => {
  const { configPath, text } = fixture();
  writeFileSync(configPath, `${text}\nprivate-canary = \"unterminated`);
  const result = inspectCodexIntegration({ readOnly: true });
  expect(result.conflicts).toMatchObject([{ category: "invalid_config" }]);
  expect(JSON.stringify(result.conflicts)).not.toContain("private-canary");
});

test("read-only inspection still rejects changed or reordered Interrupt hooks", () => {
  const { configPath, journal, text } = fixture();
  writeFileSync(configPath, text.replace("timeout = 3", "timeout = 30"));
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toMatchObject([{ category: "hook_changed" }]);
  const reordered = text.replace(journal.interruptHook.fragment,
    `\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "another-hook"\n${journal.interruptHook.fragment}`);
  writeFileSync(configPath, reordered);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toMatchObject([{ category: "hook_changed" }]);
});
