import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getConfigPath, saveConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";
import { getCodexConfigPath, getCodexJournalPath } from "../src/codex-integration-shared";
import { preflightSetup, previewSetupConfiguration, setup, type SetupOptions } from "../src/setup";
import { ROUTES_BEGIN, ROUTES_END } from "../src/codex-config-source";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { parseTomlValue } from "../src/toml-edit";
import { describeCodexSourceChange } from "../src/codex-configuration-plan";

async function fixture(run: (options: SetupOptions) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "cgw-setup-review-"));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CODEX_CHATGPT_WEB_HOME: process.env.CODEX_CHATGPT_WEB_HOME };
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(process.env.CODEX_HOME);
  try { await run({ mode: "browser-only", browserHostDescriptorPath: join(root, "descriptor.json"), acknowledgedUnofficial: true, subagentProtocol: "native" }); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}

test("fresh setup previews are stable and read-only and stale approvals fail before browser or runtime effects", () => fixture(async options => {
  const original = '# user preferences\n[features]\ncontext_management = { experimental_mode = true }\n';
  writeFileSync(getCodexConfigPath(), original);
  const preview = previewSetupConfiguration(options);
  expect(preview.status).toBe("ready");
  expect(previewSetupConfiguration(options)).toEqual(preview);
  expect(preview.textChanges?.[0]?.after).toContain(ROUTES_BEGIN);
  expect(preview.textChanges?.[0]?.after).toContain(ROUTES_END);
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
  expect(existsSync(getConfigPath())).toBe(false);
  expect(existsSync(getCodexJournalPath())).toBe(false);
  preflightSetup({ ...options, configurationApproval: preview.approvalId });
  writeFileSync(getCodexConfigPath(), original + '# independent edit\n');
  expect(() => preflightSetup({ ...options, configurationApproval: preview.approvalId })).toThrow("changed since preview");
  await expect(setup({ ...options, configurationApproval: preview.approvalId })).rejects.toThrow("changed since preview");
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original + '# independent edit\n');
  expect(existsSync(getConfigPath())).toBe(false);
}));

test("setup and repair share commented source and ambiguous-section detection", () => fixture(options => {
  const text = `${ROUTES_BEGIN}\n# openai_base_url="old"\n# experimental_realtime_webrtc_call_base_url="voice"\n${ROUTES_END}\n`;
  writeFileSync(getCodexConfigPath(), text);
  const preview = previewSetupConfiguration(options);
  expect(preview.status).toBe("ready");
  expect(preview.changes.find(change => change.path === "openai_base_url")).toMatchObject({ currentState: "commented_out", currentLines: [2] });
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(text);
  writeFileSync(getCodexConfigPath(), text.replace(ROUTES_END, ""));
  const blocked = previewSetupConfiguration(options);
  expect(blocked.status).toBe("blocked");
  expect(blocked.conflicts.some(conflict => conflict.message.includes("no end marker"))).toBe(true);
}));

test("setup previews guided resolution of duplicates without changing source", () => fixture(options => {
  const text = 'openai_base_url="one"\nopenai_base_url="two" # preserve\n';
  writeFileSync(getCodexConfigPath(), text);
  const blocked = previewSetupConfiguration({ ...options, replaceCodexRoute: true });
  const setting = blocked.groups!.flatMap(group => group.settings).find(item => item.path === "openai_base_url")!;
  expect(setting.occurrences).toHaveLength(2);
  const resolutions = [{ occurrenceId: setting.occurrences[0]!.id }];
  const preview = previewSetupConfiguration({ ...options, replaceCodexRoute: true, resolutions });
  expect(preview.status).toBe("ready");
  expect(preview.textChanges![0]!.after).toContain('# openai_base_url="two" # preserve');
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(text);
  expect(() => preflightSetup({ ...options, replaceCodexRoute: true, configurationApproval: preview.approvalId })).toThrow("changed since preview");
}));

test("setup exposes bounded duplicate table consolidation alongside assignment choices", () => fixture(options => {
  const original = '[features]\nmulti_agent=true\n[other]\nkeep="unchanged"\n[features]\nmulti_agent_v2=true\n';
  writeFileSync(getCodexConfigPath(), original);
  const blocked = previewSetupConfiguration(options);
  const table = blocked.groups!.flatMap(group => group.settings).find(setting => setting.resolutionKind === "table")!;
  expect(table.occurrences).toHaveLength(2);
  const preview = previewSetupConfiguration({ ...options, resolutions: [{ occurrenceId: table.occurrences[0]!.id }] });
  expect(preview.status).toBe("ready");
  expect(preview.textChanges![0]!.after).toContain('# [features]\n# multi_agent_v2=true');
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
}));

test("setup offers bounded route-section consolidation without acquiring unrelated contents", () => fixture(options => {
  const original = `${ROUTES_BEGIN}\nopenai_base_url="one"\n${ROUTES_END}\n${ROUTES_BEGIN}\nexperimental_realtime_webrtc_call_base_url="voice"\nkeep="untouched"\n${ROUTES_END}\n`;
  writeFileSync(getCodexConfigPath(), original);
  const blocked = previewSetupConfiguration({ ...options, replaceCodexRoute: true });
  const section = blocked.groups!.flatMap(group => group.settings).find(setting => setting.resolutionKind === "route-section")!;
  expect(section.occurrences).toHaveLength(2);
  const preview = previewSetupConfiguration({ ...options, replaceCodexRoute: true, resolutions: [{ occurrenceId: section.occurrences[0]!.id }] });
  expect(preview.status).toBe("ready");
  expect(preview.textChanges![0]!.after).toContain('keep="untouched"');
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
}));

test("existing-install setup reactivates tracked comments and explicit replacement cannot bypass broken boundaries", () => fixture(options => {
  const config = defaultConfig("browser-only");
  saveConfig(config);
  installCodexIntegration(config);
  const disabled = readFileSync(getCodexConfigPath(), "utf8").replace(/^openai_base_url/gm, "# openai_base_url").replace(/^experimental_realtime_webrtc_call_base_url/gm, "# experimental_realtime_webrtc_call_base_url");
  writeFileSync(getCodexConfigPath(), disabled);
  const preview = previewSetupConfiguration({ ...options, replaceCodexRoute: true });
  expect(preview.status).toBe("ready");
  const after = preview.textChanges?.[0]?.after ?? "";
  expect(after).not.toContain("# openai_base_url");
  expect(after).not.toContain("# experimental_realtime_webrtc_call_base_url");
  writeFileSync(getCodexConfigPath(), disabled.replace(ROUTES_END, ""));
  expect(previewSetupConfiguration({ ...options, replaceCodexRoute: true }).status).toBe("blocked");
}));

for (const structured of [false, true]) test(`setup reviews existing conflicts for each selected protocol without collapsing findings or changing files (structured V2: ${structured})`, () => fixture(async options => {
  const config = defaultConfig("browser-only");
  saveConfig(config);
  installCodexIntegration(config);
  const disabled = readFileSync(getCodexConfigPath(), "utf8")
    .replace(/^openai_base_url/gm, "# openai_base_url")
    .replace(/^experimental_realtime_webrtc_call_base_url/gm, "# experimental_realtime_webrtc_call_base_url")
    .replace("multi_agent_v2 = false", structured ? 'multi_agent_v2 = { enabled = true, context_management = "keep" }' : "multi_agent_v2 = true");
  writeFileSync(getCodexConfigPath(), disabled);
  const native = previewSetupConfiguration({ ...options, subagentProtocol: "native" });
  const compatible = previewSetupConfiguration({ ...options, subagentProtocol: "compatibility-v1" });
  expect(native.status).toBe("ready");
  expect(compatible.status).toBe("ready");
  const v2Path = structured ? "features.multi_agent_v2.enabled" : "features.multi_agent_v2";
  expect(native.conflicts.map(conflict => conflict.path)).toEqual(["openai_base_url", "experimental_realtime_webrtc_call_base_url", v2Path]);
  expect(native.changes.some(change => change.path.startsWith("features.multi_agent_v2"))).toBe(false);
  expect(compatible.changes.find(change => change.path === v2Path)).toMatchObject({ current: true, proposed: false });
  expect(compatible.changes.some(change => change.path.includes("context_management"))).toBe(false);
  expect(native.approvalId).not.toBe(compatible.approvalId);
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(disabled);
  expect(parseTomlValue(disabled)).toHaveProperty(v2Path, true);
  await expect(setup(options)).rejects.toThrow("approve its exact preview");
  expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(disabled);
}));

for (const existingRepair of [false, true]) for (const externalEdit of [false, true]) test(`approved setup uses the exact Codex plan and preserves concurrent runtime edits (existing repair: ${existingRepair}, external edit: ${externalEdit})`, () => fixture(async options => {
  // Browser account inspection is substituted; planning, files, CLI setup logic, and transactions are real.
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  options.port = portProbe.port!;
  await portProbe.stop(true);
  let original = "";
  if (existingRepair) {
    const config = defaultConfig("browser-only");
    saveConfig(config);
    installCodexIntegration(config);
    original = readFileSync(getCodexConfigPath(), "utf8")
      .replace(/^openai_base_url/gm, "# openai_base_url")
      .replace("multi_agent_v2 = false", 'multi_agent_v2 = { enabled = true, context_management = "preserve" }');
    writeFileSync(getCodexConfigPath(), original);
  }
  let inspections = 0;
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    expect(new URL(request.url).pathname).toBe("/v1/session/inspect");
    inspections++;
    if (externalEdit) {
      mkdirSync(process.env.CODEX_CHATGPT_WEB_HOME!, { recursive: true });
      writeFileSync(getConfigPath(), '{"independent":"edit"}\n');
    }
    return Response.json({ authenticated: true, temporary: true, solAvailable: true, proAvailable: false, url: "https://chatgpt.com/?temporary-chat=true" });
  } });
  try {
    writeFileSync(options.browserHostDescriptorPath!, JSON.stringify({
      version: 2, kind: "codex-web-gpt-launcher", profile: "production", pid: process.pid,
      endpoint: "http://127.0.0.1:48121", control: { endpoint: `http://127.0.0.1:${control.port}`, token: "t".repeat(48) },
      helper: { executable: process.execPath, script: import.meta.path }, partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL, surfaceId: "s".repeat(32), createdAt: new Date().toISOString(),
    }), { mode: 0o600 });
    const preview = previewSetupConfiguration(options);
    expect(preview.status).toBe("ready");
    expect(inspections).toBe(0);
    if (externalEdit) {
      await expect(setup({ ...options, configurationApproval: preview.approvalId })).rejects.toThrow("input changed since approval");
      expect(readFileSync(getConfigPath(), "utf8")).toBe('{"independent":"edit"}\n');
      if (existingRepair) expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(original);
      else expect(existsSync(getCodexConfigPath())).toBe(false);
    } else {
      await setup({ ...options, configurationApproval: preview.approvalId });
      const installed = readFileSync(getCodexConfigPath(), "utf8");
      expect(describeCodexSourceChange(getCodexConfigPath(), original, installed)).toEqual(preview.textChanges!);
      if (existingRepair) expect(parseTomlValue(installed)).toHaveProperty("features.multi_agent_v2", { enabled: true, context_management: "preserve" });
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toMatchObject({ browserHost: "launcher", subagentProtocol: "native", solAvailable: true });
      expect(existsSync(getCodexJournalPath())).toBe(true);
    }
    expect(inspections).toBe(1);
  } finally { await control.stop(true); }
}));
