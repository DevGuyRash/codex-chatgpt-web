import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, getConfigPath, loadConfig, saveConfig } from "../src/config";
import { installCodexIntegration, inspectCodexIntegration } from "../src/codex-integration";
import { getCodexConfigPath, getCodexJournalPath, getCodexJournalRecoveryPath } from "../src/codex-integration-shared";
import { applyCodexIntegrationRepair, previewCodexIntegrationRepair } from "../src/codex-integration-repair";

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

test("changed hook identity blocks repair instead of acquiring it implicitly", () => fixture((path, original) => {
  writeFileSync(path, original.replace("timeout = 3", "timeout = 30"));
  const preview = previewCodexIntegrationRepair("native");
  expect(preview.status).toBe("blocked");
  expect(preview.conflicts).toMatchObject([
    { path: "features.multi_agent", category: "value_changed" },
    { path: "features.multi_agent_v2", category: "value_changed" },
    { path: "hooks.Interrupt", category: "hook_changed" },
  ]);
  expect(preview.approvalId).toBe("");
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
