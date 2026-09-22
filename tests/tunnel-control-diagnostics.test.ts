import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticsClient } from "../src/diagnostics/client";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { problemFor } from "../src/diagnostics/problems";

const { RuntimeSupervisor } = createRequire(import.meta.url)("../launcher/electron/runtime-supervisor.cjs");

test.skipIf(process.platform === "win32")("tunnel control Unix signal failure has correlated process evidence through the production diagnostic worker and query", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-tunnel-diagnostics-"));
  const client = new DiagnosticsClient({ executable: process.execPath, args: [resolve("src/cli.ts"), "--home", root, "diagnostics", "worker"] });
  const diagnostics = new Diagnostics(client, { component: "launcher", target: "fixture", environment: "test" });
  const parent = diagnostics.begin("runtime.start", {}, null);
  const supervisor = new RuntimeSupervisor({ coreHome: root, diagnostics });
  try {
    const failure = await parent.run(() => supervisor.runTunnelCommand({ tunnel: { binaryPath: process.execPath, profileDir: root } }, ["-e", "console.log('SYNTHETIC_PRIVATE_STDOUT'); console.error('SYNTHETIC_PRIVATE_STDERR'); setInterval(() => {}, 1000)"], 250, "Local tunnel health discovery")).catch((error: unknown) => error);
    expect(problemFor(failure)).toMatchObject({ code: "tunnel_control_timeout", origin: "tunnel-client", signal: "SIGTERM", traceId: parent.context.traceId });
    parent.end("failed"); await diagnostics.close(); await client.flush();
    const query = await client.query({ view: "events", traceId: parent.context.traceId, limit: 200 });
    const ended = query.events.find(event => event.name === "tunnel.control" && event.span?.endTime);
    expect(ended).toMatchObject({ parentSpanId: parent.context.spanId, span: { outcome: "failed" }, attributes: { timedOut: true, exitObserved: true, outputDrained: true, signal: "SIGTERM", stdoutTruncated: false, stderrTruncated: false } });
    expect(ended!.attributes.stdoutBytes).toBeGreaterThan(0);
    expect(ended!.attributes.stderrBytes).toBeGreaterThan(0);
    expect(query.events.some(event => event.name === "tunnel.control_started" && event.spanId === ended!.spanId)).toBeTrue();
    expect(query.events.some(event => event.name === "tunnel.control_deadline" && event.spanId === ended!.spanId)).toBeTrue();
    expect(query.events.some(event => event.name === "tunnel.control_exited" && event.spanId === ended!.spanId)).toBeTrue();
    expect(query.events.find(event => event.kind === "problem" && event.spanId === ended!.spanId)?.problem).toMatchObject({ code: "tunnel_control_timeout", stage: "tunnel.control", origin: "tunnel-client", signal: "SIGTERM" });
    expect(JSON.stringify(query.events)).not.toContain("SYNTHETIC_PRIVATE");
    expect(query.events.some(event => event.problem?.httpStatus || event.problem?.code === "server_is_overloaded")).toBeFalse();
  } finally { await diagnostics.close(); await client.close(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
