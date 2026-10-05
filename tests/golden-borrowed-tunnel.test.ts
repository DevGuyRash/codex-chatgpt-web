import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { assertBorrowedTunnelInactive, readBorrowedTunnel } from "../scripts/golden/borrowed-tunnel";

test("borrowing the configured tunnel requires an inactive source and rejects other active aliases without mutation", async () => {
  const context = resolve(import.meta.dir, "../context"); mkdirSync(context, { recursive: true });
  const root = mkdtempSync(join(context, "gbt-")), isolated = join(root, "isolated"), sourceHome = join(root, "source");
  for (const path of [isolated, sourceHome]) mkdirSync(path);
  const binary = join(root, "tunnel"), mode = join(root, "mode"), calls = join(root, "calls");
  const tunnelId = `tunnel_${"b".repeat(32)}`;
  writeFileSync(mode, "stopped");
  writeFileSync(binary, `#!${process.execPath}\nimport { appendFileSync, readFileSync } from "node:fs";\nconst action=process.argv[3], alias=process.argv[4], mode=readFileSync(${JSON.stringify(mode)},"utf8");\nappendFileSync(${JSON.stringify(calls)}, action + "\\n");\nif(action === "list") console.log(JSON.stringify({aliases:[{alias:"source",tunnel_id:${JSON.stringify(tunnelId)}},{alias:"other",tunnel_id:${JSON.stringify(tunnelId)}}]}));\nelse if(action === "status") console.log(JSON.stringify(mode === "unknown" ? {} : {runtime_state:mode === "active" && alias === "other" ? "ready" : mode === "starting" && alias === "source" ? "starting" : "stopped",process_running:mode === "active" && alias === "other",healthy:false,ready:false}));\nelse process.exit(99);\n`, { mode: 0o700 }); chmodSync(binary, 0o700);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
  const source = { ...defaultConfig("full", sourceHome), port: address.port, tunnel: { binaryPath: binary, tunnelId, runtimeKeyFile: join(sourceHome, "fixture.key"), profileDir: join(sourceHome, "profiles"), profileName: "source", alias: "source" } };
  const configPath = join(sourceHome, "config.json"); writeFileSync(configPath, JSON.stringify(source), { mode: 0o600 });
  const selected = { ...source, brokerSocketPath: join(isolated, "broker.sock"), tunnel: { ...source.tunnel, alias: "golden-fixture", profileDir: join(isolated, "profiles") } };
  const original = readFileSync(configPath);
  try {
    expect(readBorrowedTunnel(sourceHome, isolated, selected).appName).toBe(source.appName);
    expect(() => readBorrowedTunnel(sourceHome, isolated, { ...selected, appName: "different" })).toThrow("differs");
    await expect(assertBorrowedTunnelInactive(sourceHome, isolated, selected)).rejects.toThrow("Responses server is active");
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await assertBorrowedTunnelInactive(sourceHome, isolated, selected);
    writeFileSync(mode, "active");
    await expect(assertBorrowedTunnelInactive(sourceHome, isolated, selected)).rejects.toMatchObject({ code: "borrowed_tunnel_active" });
    writeFileSync(mode, "starting");
    await expect(assertBorrowedTunnelInactive(sourceHome, isolated, selected)).rejects.toMatchObject({ code: "borrowed_tunnel_state_uncertain", message: expect.stringContaining("starting") });
    writeFileSync(mode, "unknown");
    await expect(assertBorrowedTunnelInactive(sourceHome, isolated, selected)).rejects.toMatchObject({ code: "borrowed_tunnel_state_uncertain", message: expect.stringContaining("unknown") });
    mkdirSync(join(sourceHome, "runtime"));
    writeFileSync(source.brokerSocketPath, "unresolved socket owner");
    await expect(assertBorrowedTunnelInactive(sourceHome, isolated, selected)).rejects.toThrow("broker still exists");
    expect(readFileSync(configPath).equals(original)).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n").every(action => ["list", "status"].includes(action))).toBe(true);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
