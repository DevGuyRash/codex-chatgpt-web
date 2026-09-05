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

for (const externalEdit of [false, true]) test(`approved setup uses the exact Codex plan and preserves concurrent runtime edits (${externalEdit})`, () => fixture(async options => {
  // Browser account inspection is substituted; planning, files, CLI setup logic, and transactions are real.
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  options.port = portProbe.port!;
  await portProbe.stop(true);
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
      expect(existsSync(getCodexConfigPath())).toBe(false);
    } else {
      await setup({ ...options, configurationApproval: preview.approvalId });
      expect(readFileSync(getCodexConfigPath(), "utf8")).toBe(preview.textChanges![0]!.after);
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toMatchObject({ browserHost: "launcher", subagentProtocol: "native", solAvailable: true });
      expect(existsSync(getCodexJournalPath())).toBe(true);
    }
    expect(inspections).toBe(1);
  } finally { await control.stop(true); }
}));
