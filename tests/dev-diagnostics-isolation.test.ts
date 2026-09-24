import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("DEV CLI binds diagnostics to its own home before creating a worker", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-diagnostics-"));
  const production = join(root, "production"), development = join(root, "development");
  mkdirSync(production); mkdirSync(development);
  const cli = resolve(import.meta.dir, "../src/cli.ts");
  try {
    const status = Bun.spawnSync([process.execPath, cli, "dev", "status", "--json"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, CODEX_CHATGPT_WEB_HOME: production, CODEX_WEB_GPT_DEV_HOME: development,
        CODEX_CHATGPT_WEB_DIAGNOSTICS_WORKER: "foreign-worker", CODEX_CHATGPT_WEB_DIAGNOSTICS_FD: "3",
        CODEX_CHATGPT_WEB_TRACEPARENT: "foreign-parent", CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID: "foreign-campaign" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(status.exitCode).toBe(0);
    expect(existsSync(join(production, "diagnostics"))).toBe(false);
    expect(existsSync(join(development, "diagnostics"))).toBe(true);
    const query = Bun.spawnSync([process.execPath, cli, "--home", development, "diagnostics", "search", "cli.dev", "--json"], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    expect(query.exitCode).toBe(0);
    const result = JSON.parse(query.stdout.toString()) as { events: Array<{ name: string; environment: string }> };
    expect(result.events.some(event => event.name === "cli.dev" && event.environment === "development")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
