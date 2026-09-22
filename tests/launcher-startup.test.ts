import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { DiagnosticError } from "../src/diagnostics/problems";
import type { DiagnosticEvent, Problem } from "../src/diagnostics/contracts";

const { runStartup } = createRequire(import.meta.url)("../launcher/electron/startup.cjs");

test("cancelling startup review does not invent a failure or invoke route recovery", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "launcher", environment: "test", target: "fixture" });
  const calls: string[] = [];
  try {
    await runStartup({ logger: { diagnostics }, start: async () => { throw new DOMException("Review cancelled", "AbortError"); }, recover: async () => { calls.push("recover"); }, failed: async () => { calls.push("failed"); }, cancelled: async () => { calls.push("cancelled"); } });
    expect(calls).toEqual(["cancelled"]);
    expect(events.filter(event => event.kind === "problem")).toHaveLength(0);
    expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("cancelled");
  } finally { await diagnostics.close(); }
});

test("unconfigured startup records one failed recovery without retrying it", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "launcher", environment: "test", target: "fixture" });
  let recoveries = 0, reset = false, failure: Problem | undefined;
  try {
    await runStartup({ logger: { diagnostics }, start: async () => ({ status: "not-configured" }), notConfigured: async () => { reset = true; },
      recover: async () => { recoveries++; throw new Error("Private recovery error"); }, failed: async (problem: Problem) => { failure = problem; } });
    expect(reset).toBe(true);
    expect(recoveries).toBe(1);
    expect(failure?.code).toBe("runtime_not_configured");
    expect(failure?.recovery).toBe("incomplete");
    expect(failure?.causes).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Private recovery error");
  } finally { await diagnostics.close(); }
});

test("startup keeps running-runtime evidence and configuration findings without invoking recovery", async () => {
  const events: DiagnosticEvent[] = [], failures: Problem[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "launcher", environment: "test", target: "fixture" });
  let recoveryCalls = 0;
  const findings = [{ path: "experimental_realtime_webrtc_call_base_url", message: "Managed realtime URL missing" }, { path: "hooks.Interrupt", message: "Interrupt hook differs" }];
  try {
    await runStartup({ logger: { diagnostics }, start: async (observe: (status: string) => void) => {
      observe("ready");
      throw new DiagnosticError({ code: "codex_configuration_conflict", message: "Review configuration", findings });
    }, recover: async () => { recoveryCalls++; }, failed: async (problem: Problem) => { failures.push(problem); } });
    expect(recoveryCalls).toBe(0);
    expect(failures[0].findings).toEqual(findings);
    expect(failures[0].recovery).toBe("not-started");
    expect(failures[0].actions).toContain("review-configuration");
    const terminal = events.find(event => event.span?.outcome === "failed")!;
    expect(terminal.attributes["runtime.state"]).toBe("ready");
    expect(terminal.attributes["integration.ready"]).toBe(false);
    expect(failures[0].traceId).toBe(terminal.traceId);
  } finally { await diagnostics.close(); }
});

test("startup preserves original failure and correlates successful or failed recovery", async () => {
  for (const restored of [true, false]) {
    const events: DiagnosticEvent[] = [];
    const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "launcher", environment: "test", target: "fixture" });
    let failure: Problem | undefined;
    try {
      await runStartup({ logger: { diagnostics }, start: async () => { throw new DiagnosticError({ code: "runtime_start_failed", message: "Runtime could not start" }); },
        recover: () => diagnostics.run("route-recovery", async () => restored ? { restored } : { restored, problem: new DiagnosticError({ code: "codex_route_verification_failed", message: "Restored route could not be verified" }).problem }),
        failed: async (problem: Problem) => { failure = problem; } });
      expect(failure?.code).toBe("runtime_start_failed");
      expect(failure?.message).toBe("Runtime could not start");
      expect(failure?.recovery).toBe(restored ? "completed" : "incomplete");
      expect(failure?.causes).toEqual(restored ? [] : [{ code: "codex_route_verification_failed", message: "Restored route could not be verified" }]);
      expect(new Set(events.map(event => event.traceId)).size).toBe(1);
      expect(events.filter(event => event.kind === "problem")).toHaveLength(1);
    } finally { await diagnostics.close(); }
  }
});
