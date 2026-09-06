import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getConfigPath, loadConfig, saveConfig } from "../src/config";
import { installCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";
import { getCodexConfigPath, getCodexJournalPath, getCodexJournalRecoveryPath } from "../src/codex-integration-shared";
import { applyCodexIntegrationRepair, previewCodexIntegrationRepair } from "../src/codex-integration-repair";
import { restoreCodexInterruptHook, MANAGED_INTERRUPT_HOOK_START } from "../src/codex-interrupt-hook";
import { setTomlScalar } from "../src/toml-edit";
import { inspectCodexConfigSource, sourceAssignments } from "../src/codex-config-source";
import type { CodexIntegrationJournal } from "../src/codex-integration-shared";

async function fixture(run: (path: string, original: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-repair-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME };
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  try {
    const config = defaultConfig("browser-only");
    saveConfig(config);
    installCodexIntegration(config);
    const path = getCodexConfigPath();
    const changed = readFileSync(path, "utf8").replace("multi_agent_v2 = false", "multi_agent_v2 = true")
      .replace("multi_agent = true", "multi_agent = false");
    writeFileSync(path, changed);
    await run(path, changed);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("repair previews every conflicting setting without writing any file", () => fixture((path, original) => {
  const paths = [path, getConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()];
  const before = paths.map(path => readFileSync(path, "utf8"));
  const preview = previewCodexIntegrationRepair("compatibility-v1");
  expect(preview.status).toBe("ready");
  expect(preview.approvalId).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.changes).toMatchObject([
    { path: "features.multi_agent", current: false, proposed: true },
    { path: "features.multi_agent_v2", current: true, proposed: false },
  ]);
  expect(paths.map(path => readFileSync(path, "utf8"))).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(original);
}));

test("guided duplicate resolution binds exact source choices and preserves disabled alternatives", () => fixture((path, original) => {
  const duplicated = original.replace('multi_agent_v2 = true', 'multi_agent_v2 = true\nmulti_agent_v2 = false # alternate');
  writeFileSync(path, duplicated);
  const blocked = previewCodexIntegrationRepair("native");
  expect(blocked.status).toBe("blocked");
  const setting = blocked.groups!.flatMap(group => group.settings).find(item => item.path === "features.multi_agent_v2")!;
  expect(setting.occurrences).toHaveLength(2);
  const resolutions = [{ occurrenceId: setting.occurrences[0]!.id }];
  const preview = previewCodexIntegrationRepair("native", { resolutions });
  expect(preview.status).toBe("ready");
  expect(readFileSync(path, "utf8")).toBe(duplicated);
  expect(() => applyCodexIntegrationRepair("native", preview.approvalId)).toThrow("changed");
  applyCodexIntegrationRepair("native", preview.approvalId, { resolutions });
  const result = readFileSync(path, "utf8");
  expect(result).toContain('multi_agent_v2 = true');
  expect(result).toContain('# multi_agent_v2 = false # alternate');
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
}));

test("repair needs the exact preview approval and rejects subsequent edits", () => fixture((path, original) => {
  const preview = previewCodexIntegrationRepair("compatibility-v1");
  expect(() => applyCodexIntegrationRepair("compatibility-v1", "wrong")).toThrow("approval");
  writeFileSync(path, original + '\n[user]\nlabel="new user edit"\n');
  expect(() => applyCodexIntegrationRepair("compatibility-v1", preview.approvalId)).toThrow("changed");
  expect(readFileSync(path, "utf8")).toContain("new user edit");
}));

test("approved repair changes only the previewed values and verifies the result", () => fixture((path, original) => {
  const preview = previewCodexIntegrationRepair("compatibility-v1");
  applyCodexIntegrationRepair("compatibility-v1", preview.approvalId);
  expect(readFileSync(path, "utf8")).toBe(original.replace("multi_agent = false", "multi_agent = true").replace("multi_agent_v2 = true", "multi_agent_v2 = false"));
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
}));

test("Native repair preserves newer feature choices and updates both protocol authorities", () => fixture((path, original) => {
  const preview = previewCodexIntegrationRepair("native");
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(readFileSync(path, "utf8")).toContain("multi_agent_v2 = true");
  expect(readFileSync(path, "utf8")).toContain("multi_agent = false");
  expect(loadConfig().subagentProtocol).toBe("native");
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
}));

test("approved compatibility acquisition shares setup's inline feature baseline", () => fixture((path) => {
  applyCodexIntegrationRepair("native", previewCodexIntegrationRepair("native").approvalId);
  const config = readFileSync(path, "utf8");
  // Replace this synthetic fixture's feature block while retaining its real hook journal.
  const start = config.indexOf("[features]");
  const next = config.indexOf("[", start + "[features]".length);
  if (start < 0) throw new Error("Fixture features missing");
  const inline = 'features = { multi_agent = false, multi_agent_v2 = { enabled = true, concurrency = 6 }, context_management = { experimental_mode = true } }\n';
  const withoutFeatures = config.slice(0, start) + (next < 0 ? "" : config.slice(next));
  writeFileSync(path, inline + withoutFeatures);
  const preview = previewCodexIntegrationRepair("compatibility-v1");
  expect(preview.status).toBe("ready");
  applyCodexIntegrationRepair("compatibility-v1", preview.approvalId);
  expect(inspectCodexIntegration().errors).toEqual([]);
  applyCodexIntegrationRepair("native", previewCodexIntegrationRepair("native").approvalId);
  const restored = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(restored.features).toEqual({ multi_agent: false, multi_agent_v2: { enabled: true, concurrency: 6 }, context_management: { experimental_mode: true } });
}));

test("a journal or runtime change invalidates an approval even if Codex TOML is unchanged", () => fixture((_path, _original) => {
  const preview = previewCodexIntegrationRepair("compatibility-v1");
  const runtime = JSON.parse(readFileSync(getConfigPath(), "utf8"));
  runtime.headed = !runtime.headed;
  writeFileSync(getConfigPath(), JSON.stringify(runtime));
  expect(() => applyCodexIntegrationRepair("compatibility-v1", preview.approvalId)).toThrow("changed");
}));

test("changed hook command identity blocks repair instead of acquiring it implicitly", () => fixture((path, original) => {
  const journal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  writeFileSync(path, original.replace(JSON.stringify(journal.interruptHook.command), JSON.stringify(journal.interruptHook.command + " --user-change")));
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("blocked");
  expect(preview.conflicts).toMatchObject([
    { path: "features.multi_agent", category: "value_changed" },
    { path: "features.multi_agent_v2", category: "value_changed" },
    { path: "hooks.Interrupt", category: "hook_changed" },
  ]);
  expect(preview.approvalId).toBe("");
}));

for (const form of ["missing", "commented", "changed"] as const) test(`identified hook settings repair ${form} values without rewriting neighbors`, () => fixture((path, original) => {
  const changed = original.replace("timeout = 3", form === "missing" ? "" : form === "commented" ? '# "timeout"   = 30 # keep spacing' : '"timeout"   = 30 # keep spacing')
    .replace(/trusted_hash = "[^"]+"/, form === "missing" ? "" : form === "commented" ? '# trusted_hash = "old" # trust note' : 'trusted_hash = "old" # trust note');
  writeFileSync(path, changed);
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  expect(readFileSync(path, "utf8")).toBe(changed);
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  if (form !== "missing") expect(readFileSync(path, "utf8")).toContain('"timeout"   = 3 # keep spacing');
  expect(readFileSync(path, "utf8")).toContain("multi_agent_v2 = true");
}));

for (const ending of ["\n", "\r\n", "\r"]) test(`fully commented managed hook block is reactivated with source formatting (${JSON.stringify(ending)})`, () => fixture((path, original) => {
  const journal: CodexIntegrationJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const block = journal.interruptHook.fragment.replace(/timeout = 3/, '"timeout"   = 3 # keep note');
  const disabled = block.split("\n").map(line => line && !line.startsWith("#") ? `# ${line}` : line).join("\n");
  const damaged = original.replace(journal.interruptHook.fragment, disabled).replace(/\n/g, ending);
  writeFileSync(path, damaged);
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  expect(preview.changes.filter(change => change.path.startsWith("hooks.")).every(change => change.currentState === "commented_out")).toBe(true);
  expect(preview.conflicts.some(conflict => conflict.category === "commented_out" && conflict.path.startsWith("hooks.Interrupt"))).toBe(true);
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  expect(readFileSync(path, "utf8")).toContain('"timeout"   = 3 # keep note');
}));

test("commented hook activation cannot enable unrelated settings", () => fixture((path, original) => {
  const journal: CodexIntegrationJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const disabled = journal.interruptHook.fragment.split("\n").map(line => line && !line.startsWith("#") ? `# ${line}` : line).join("\n")
    .replace('# type = "command"', '# type = "command"\n# unrelated = true');
  writeFileSync(path, original.replace(journal.interruptHook.fragment, disabled));
  expect(previewCodexIntegrationRepair("native").status).toBe("blocked");
}));

test("hook examples in multiline strings remain inert during restoration", () => fixture((path, original) => {
  const journal: CodexIntegrationJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const missing = restoreCodexInterruptHook(original, journal.interruptHook);
  const note = `example = '''${journal.interruptHook.fragment}'''\n`;
  writeFileSync(path, note + missing);
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  expect(preview.changes.filter(change => change.path.startsWith("hooks.")).every(change => change.currentState === "missing")).toBe(true);
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(readFileSync(path, "utf8")).toStartWith(note);
}));

test("identified hook type, asynchronous flag and commented command use the shared scalar repair", () => fixture((path, original) => {
  const journal: CodexIntegrationJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const damaged = original.replace('type = "command"', 'type = "other"\nasync = true')
    .replace(`command = ${JSON.stringify(journal.interruptHook.command)}`, `# command = ${JSON.stringify(journal.interruptHook.command)}`);
  writeFileSync(path, damaged);
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  expect(readFileSync(path, "utf8")).toContain('async = false');
}));

test("missing managed hook and WebRTC setting produce an exact approvable restoration", () => fixture((path, original) => {
  const journal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const missing = restoreCodexInterruptHook(original, journal.interruptHook)
    .replace(/^experimental_realtime_webrtc_call_base_url.*\n/m, "")
    + '\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "user-start-hook"\n';
  writeFileSync(path, missing);
  const paths = [path, getConfigPath(), getCodexJournalPath(), getCodexJournalRecoveryPath()];
  const before = paths.map(file => readFileSync(file, "utf8"));
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  expect(preview.changes.some(change => change.path.startsWith("hooks.Interrupt"))).toBe(true);
  expect(preview.changes.some(change => change.path === "experimental_realtime_webrtc_call_base_url")).toBe(true);
  expect(preview.groups?.find(group => group.id === "integrations")?.settings.some(setting => setting.path === "hooks.Interrupt") ?? false).toBe(false);
  expect(preview.groups?.find(group => group.id === "interrupt")?.settings.some(setting => setting.findings.some(finding => finding.category === "missing"))).toBe(true);
  expect(paths.map(file => readFileSync(file, "utf8"))).toEqual(before);
  expect(() => applyCodexIntegrationRepair("native", "wrong")).toThrow("approval");
  applyCodexIntegrationRepair("native", preview.approvalId);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  expect(readFileSync(path, "utf8")).toContain('command = "user-start-hook"');
  expect(readFileSync(path, "utf8")).toContain("multi_agent_v2 = true");
  expect(loadConfig().subagentProtocol).toBe("native");
}));

test("missing-hook approval rejects a hook added after preview", () => fixture((path, original) => {
  const journal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const missing = restoreCodexInterruptHook(original, journal.interruptHook);
  writeFileSync(path, missing);
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("ready");
  const edited = missing + '\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "user-interrupt-hook"\n';
  writeFileSync(path, edited);
  expect(() => applyCodexIntegrationRepair("native", preview.approvalId)).toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe(edited);
}));

test("partial hook removal, duplicate hooks and reordered hooks remain blocked", () => fixture((path, original) => {
  const journal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
  const missing = restoreCodexInterruptHook(original, journal.interruptHook);
  const other = '\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "user-interrupt-hook"\n';
  const residualTrust = `\n[hooks.state.${JSON.stringify(journal.interruptHook.stateKey)}]\ntrusted_hash = ${JSON.stringify(journal.interruptHook.trustedHash)}\n`;
  const residualMarker = `\n${MANAGED_INTERRUPT_HOOK_START}\n`;
  for (const candidate of [missing + residualTrust, missing + residualMarker, original + journal.interruptHook.fragment,
    missing + other + journal.interruptHook.fragment]) {
    writeFileSync(path, candidate);
    const preview = previewCodexIntegrationRepair("native");
    expect(preview.status).toBe("blocked");
    expect(preview.approvalId).toBe("");
    expect(readFileSync(path, "utf8")).toBe(candidate);
  }
}));

test("CLI preview and approved apply exercise the same repair contract", () => fixture(async (path) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("test") });
  const config = loadConfig();
  config.port = server.port!;
  saveConfig(config);
  await server.stop(true);
  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "route", "repair", ...args], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return JSON.parse(stdout);
  };
  const preview = await cli(["preview", "--subagent-protocol", "compatibility-v1"]);
  expect(preview.status).toBe("ready");
  expect(JSON.stringify(preview)).not.toContain(config.controlToken);
  const result = await cli(["apply", "--subagent-protocol", "compatibility-v1", "--approve", preview.approvalId]);
  expect(result.changed).toBe(true);
  expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
  expect(readFileSync(path, "utf8")).toContain(`http://127.0.0.1:${config.port}/v1`);
}));

const scalarCases = [
  { path: ["openai_base_url"], expected: (journal: CodexIntegrationJournal) => journal.installed.openai_base_url },
  { path: ["experimental_realtime_webrtc_call_base_url"], expected: (journal: CodexIntegrationJournal) => journal.installed.experimental_realtime_webrtc_call_base_url },
  { path: ["model_catalog_json"], expected: () => "/owned/catalog.json" },
  { path: ["model_provider"], expected: () => "openai" },
  { path: ["features", "multi_agent"], expected: () => true },
  { path: ["features", "multi_agent_v2"], expected: () => false },
  { path: ["agents", "max_depth"], expected: (journal: CodexIntegrationJournal) => journal.installed.agent_max_depth! },
];
for (const setting of scalarCases) for (const form of ["missing", "commented", "changed", "equivalent"] as const) for (const ending of ["\n", "\r\n", "\r"]) {
  test(`owned scalar ${setting.path.join(".")} / ${form} / ${JSON.stringify(ending)}`, () => fixture((path) => {
    applyCodexIntegrationRepair("compatibility-v1", previewCodexIntegrationRepair("compatibility-v1").approvalId);
    const journal: CodexIntegrationJournal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    journal.installed.model_catalog_json = "/owned/catalog.json";
    journal.installed.model_provider = "openai";
    for (const file of [getCodexJournalPath(), getCodexJournalRecoveryPath()]) writeFileSync(file, JSON.stringify(journal));
    let healthy = readFileSync(path, "utf8");
    for (const candidate of scalarCases) healthy = setTomlScalar(healthy, candidate.path, candidate.expected(journal));
    healthy = '\uFEFF' + healthy.replace(/\r\n|\n|\r/g, ending);
    const expected = setting.expected(journal);
    const occurrence = sourceAssignments(inspectCodexConfigSource(healthy), setting.path).find(item => item.state === "active")!;
    const wrong = typeof expected === "boolean" ? !expected : typeof expected === "number" ? 99 : "different";
    const literal = typeof expected === "number" ? `0x${expected.toString(16)}` : JSON.stringify(expected);
    const line = `${JSON.stringify(setting.path.at(-1))}   = ${form === "changed" ? JSON.stringify(wrong) : literal} # preserve café`;
    const damaged = healthy.slice(0, occurrence.range[0]) + (form === "missing" ? "" : form === "commented" ? `# ${line}` : line) + healthy.slice(occurrence.range[1]);
    writeFileSync(path, damaged);
    const preview = previewCodexIntegrationRepair("compatibility-v1");
    expect(preview.status).toBe("ready");
    expect(readFileSync(path, "utf8")).toBe(damaged);
    const change = preview.changes.find(item => item.path === setting.path.join("."));
    if (form === "equivalent") expect(change).toBeUndefined();
    else expect(change?.proposed).toBe(expected);
    if (form === "commented") expect(change?.currentState).toBe("commented_out");
    applyCodexIntegrationRepair("compatibility-v1", preview.approvalId);
    expect(inspectCodexIntegration({ readOnly: true }).conflicts).toEqual([]);
    if (form === "equivalent") expect(readFileSync(path, "utf8")).toBe(damaged);
    if (form === "commented") expect(readFileSync(path, "utf8")).toContain(line);
    expect(readFileSync(path, "utf8")).toStartWith('\uFEFF');
  }));
}
