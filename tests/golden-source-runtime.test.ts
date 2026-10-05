import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { assertBorrowedTunnelInactive } from "../scripts/golden/borrowed-tunnel";
import { readGoldenSourceRuntime } from "../scripts/golden/source-runtime";

function fixture() {
  const context = resolve(import.meta.dir, "../context"); mkdirSync(context, { recursive: true });
  const root = mkdtempSync(join(context, "golden-source-"));
  const dev = join(root, ".codex-chatgpt-web-dev"), production = join(root, ".codex-chatgpt-web");
  const write = (home: string, development: boolean) => {
    mkdirSync(home, { recursive: true });
    const config = {
      ...defaultConfig("full", home), ...(development ? { purpose: "dev-harness" as const } : {}),
      appName: development ? "Golden DEV fixture" : "Golden production fixture",
      automaticAppName: development ? "Golden DEV fixture" : "Golden production fixture",
      tunnel: { binaryPath: join(root, "tunnel"), tunnelId: `tunnel_${(development ? "d" : "a").repeat(32)}`, runtimeKeyFile: join(home, "fixture.key"), profileDir: join(home, "profiles"), profileName: development ? "dev" : "production", alias: development ? "codex-chatgpt-web-dev" : "codex-chatgpt-web" },
    };
    writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
    return config;
  };
  return { root, dev, production, write, options: { environment: {}, homeDirectory: root }, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("golden defaults select the canonical DEV connector, runtime key and tunnel, ignoring the production runtime home", () => {
  const f = fixture();
  try {
    const dev = f.write(f.dev, true), production = f.write(f.production, false);
    const selected = readGoldenSourceRuntime(undefined, { ...f.options, environment: { CODEX_CHATGPT_WEB_HOME: f.production } });
    expect(selected.home).toBe(f.dev);
    expect(selected.config).toMatchObject({ purpose: "dev-harness", appName: dev.appName, tunnel: dev.tunnel });
    expect(selected.config.tunnel?.tunnelId).not.toBe(production.tunnel.tunnelId);
    expect(readFileSync(join(f.production, "config.json"), "utf8")).toBe(JSON.stringify(production));
  } finally { f.close(); }
});

test("golden honors DEV home overrides and preserves explicitly selected source homes", () => {
  const f = fixture();
  try {
    const custom = join(f.root, "custom-dev"); f.write(custom, true); f.write(f.production, false);
    expect(readGoldenSourceRuntime(undefined, { ...f.options, environment: { CODEX_WEB_GPT_DEV_HOME: custom } }).home).toBe(custom);
    expect(readGoldenSourceRuntime(f.production, f.options).home).toBe(f.production);
    expect(() => readGoldenSourceRuntime("", f.options)).toThrow("must not be empty");
    expect(() => readGoldenSourceRuntime(undefined, { ...f.options, environment: { CODEX_WEB_GPT_DEV_HOME: f.production } })).toThrow("must differ");
  } finally { f.close(); }
});

test("missing, invalid or non-DEV default configuration never falls back to production", () => {
  const f = fixture();
  try {
    f.write(f.production, false);
    expect(() => readGoldenSourceRuntime(undefined, f.options)).toThrow(f.dev);
    f.write(f.dev, false);
    expect(() => readGoldenSourceRuntime(undefined, f.options)).toThrow("DEV dev-harness");
    writeFileSync(join(f.dev, "config.json"), "{}");
    expect(() => readGoldenSourceRuntime(undefined, f.options)).toThrow("Unsupported configuration");
  } finally { f.close(); }
});

test("default borrowing inspects DEV aliases without probing an unrelated production tunnel", async () => {
  const f = fixture(), server = createServer();
  try {
    const dev = f.write(f.dev, true), production = f.write(f.production, false);
    const isolated = join(f.root, "isolated"), calls = join(f.root, "calls"); mkdirSync(isolated);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
    dev.port = address.port;
    writeFileSync(join(f.dev, "config.json"), JSON.stringify(dev), { mode: 0o600 });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    writeFileSync(dev.tunnel.binaryPath, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst action=process.argv[3], alias=process.argv[4];\nappendFileSync(${JSON.stringify(calls)}, JSON.stringify({action,alias}) + "\\n");\nif(action === "list") console.log(JSON.stringify({aliases:${JSON.stringify([{ alias: dev.tunnel.alias, tunnel_id: dev.tunnel.tunnelId }, { alias: production.tunnel.alias, tunnel_id: production.tunnel.tunnelId }])}}));\nelse if(action === "status") console.log(JSON.stringify({runtime_state:alias === ${JSON.stringify(dev.tunnel.alias)} ? "stopped" : "ready",process_running:alias !== ${JSON.stringify(dev.tunnel.alias)},healthy:false,ready:false}));\nelse process.exit(99);\n`, { mode: 0o700 });
    const selected = readGoldenSourceRuntime(undefined, f.options);
    await assertBorrowedTunnelInactive(selected.home, isolated, selected.config);
    const observed = readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(observed).toEqual([{ action: "list", alias: "--json" }, { action: "status", alias: dev.tunnel.alias }]);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
