import { expect, test } from "bun:test";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { setRuntimeDiagnostics } from "../src/diagnostics/runtime";
import { HttpTurnCounter } from "../src/server";
import { verifySetupReadiness } from "../src/setup";
import { runtimeFailure } from "../src/diagnostics/problems";
import { isDiagnosticCancellation } from "../src/diagnostics/outcome";

function recording() {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "test", environment: "test", target: "fixture" });
  return { events, diagnostics };
}

test("a false readiness result is a failed stage with a structured cause", async () => {
  const { diagnostics, events } = recording();
  setRuntimeDiagnostics(diagnostics);
  try {
    await expect(verifySetupReadiness("setup.tunnel-ready", async () => ({ ok: false, detail: "private fixture" }))).rejects.toThrow("tunnel");
    expect(events.find(event => event.kind === "problem")?.problem?.code).toBe("tunnel_not_ready");
    expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("failed");
  } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
});

test("explicit cancellation records a cancelled operation without inventing a problem", async () => {
  const { diagnostics, events } = recording();
  const reason = new DOMException("private cancellation reason", "AbortError");
  await expect(diagnostics.run("cancelled", async () => { throw reason; })).rejects.toBe(reason);
  await diagnostics.close();
  expect(events.filter(event => event.kind === "problem")).toHaveLength(0);
  expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("cancelled");
  expect(JSON.stringify(events)).not.toContain("private cancellation reason");
});

test("CLI cancellation requires its owned envelope and cancellation exit code", () => {
  const envelope = 'CGW_CANCELLED_V1 {"version":1}';
  expect(isDiagnosticCancellation(runtimeFailure(envelope, "Failed", { exitCode: 130 }))).toBe(true);
  expect(isDiagnosticCancellation(runtimeFailure(envelope, "Failed", { exitCode: 1 }))).toBe(false);
  expect(isDiagnosticCancellation(runtimeFailure("user text cancelled", "Failed", { exitCode: 130 }))).toBe(false);
});

test("a recorded genuine failure cannot be erased by subsequent cancellation", async () => {
  const { diagnostics, events } = recording();
  await expect(diagnostics.run("failed-before-cancel", async operation => {
    operation.problem(undefined, "Genuine earlier failure");
    throw new DOMException("cancelled later", "AbortError");
  })).rejects.toMatchObject({ name: "AbortError" });
  await diagnostics.close();
  expect(events.filter(event => event.kind === "problem")).toHaveLength(1);
  expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("failed");
});

test("timeout is a failure, not an expected cancellation", async () => {
  const { diagnostics, events } = recording();
  await expect(diagnostics.run("timeout", async () => { throw new DOMException("private timeout detail", "TimeoutError"); })).rejects.toThrow();
  await diagnostics.close();
  expect(events.filter(event => event.kind === "problem")).toHaveLength(1);
  expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("failed");
  expect(JSON.stringify(events)).not.toContain("private timeout detail");
});

test("HTTP cancellation before a rejected response does not emit a contradictory failure", async () => {
  const { diagnostics, events } = recording();
  const client = new AbortController();
  setRuntimeDiagnostics(diagnostics);
  try {
    const turns = new HttpTurnCounter();
    await expect(turns.track(async () => {
      client.abort();
      throw new Error("private teardown error");
    }, client.signal, "linux", "responses")).rejects.toThrow("private teardown error");
    expect(turns.count()).toBe(0);
    expect(events.filter(event => event.kind === "problem")).toHaveLength(0);
    expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("cancelled");
  } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
});

test("HTTP failure observed before cancellation remains a failure", async () => {
  const { diagnostics, events } = recording();
  const client = new AbortController();
  setRuntimeDiagnostics(diagnostics);
  try {
    const turns = new HttpTurnCounter();
    const response = await turns.track(async () => new Response(new ReadableStream(), { status: 502 }), client.signal, "linux", "responses");
    client.abort();
    await response.body!.cancel();
    expect(events.filter(event => event.kind === "problem")).toHaveLength(1);
    expect(events.find(event => event.span?.endTime)?.span?.outcome).toBe("failed");
  } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
});
