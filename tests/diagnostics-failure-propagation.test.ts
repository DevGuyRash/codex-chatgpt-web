import { expect, test } from "bun:test";
import { adapterFailureFromMessage, adapterErrorEvent } from "../src/lib/errors";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { buildResponseJSON } from "../src/bridge";
import { problemFor } from "../src/diagnostics/problems";
import { Diagnostics } from "../src/diagnostics/instrumentation";
import { setRuntimeDiagnostics } from "../src/diagnostics/runtime";
import { responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import type { DiagnosticEvent } from "../src/diagnostics/contracts";
import { diagnosticRequestCode, DiagnosticRequestError, diagnosticRequestMessages } from "../src/diagnostics/request-error";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { MissingTrustedCodexEnvironmentError } from "../src/adapters/chatgpt-web/environment";

test("worker failures distinguish real database contention and invalid envelopes without exposing raw error text", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostic-lock-"));
  const first = new Database(join(root, "db.sqlite")), second = new Database(join(root, "db.sqlite"));
  try {
    first.exec("CREATE TABLE fixture (id INTEGER); BEGIN IMMEDIATE");
    let failure: unknown;
    try { second.exec("INSERT INTO fixture VALUES (1)"); } catch (error) { failure = error; }
    expect(diagnosticRequestCode(failure, "unavailable")).toBe("storage_busy");
    const parsed = z.string().safeParse(42);
    expect(diagnosticRequestCode(parsed.success ? undefined : parsed.error, "unavailable")).toBe("invalid_request");
    expect(diagnosticRequestCode(new Error("arbitrary private output"), "unavailable")).toBe("unavailable");
  } finally { first.exec("ROLLBACK"); first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("local availability wording does not claim provider capacity", () => {
  expect(adapterFailureFromMessage("Browser connection temporarily unavailable").error.code).not.toBe("server_is_overloaded");
});

test("worker request errors retain their typed origin in operational evidence", () => {
  expect(problemFor(new DiagnosticRequestError("storage_busy"))).toMatchObject({ code: "storage_busy", origin: "diagnostics", message: diagnosticRequestMessages.storage_busy });
});

test("missing native authority remains a non-retryable typed failure in Responses and diagnostics", () => {
  const failure = new MissingTrustedCodexEnvironmentError("cwd");
  expect(adapterErrorEvent(failure)).toMatchObject({ code: "trusted_codex_environment_missing", status: 409, retryable: false });
  expect(problemFor(failure)).toMatchObject({ code: "trusted_codex_environment_missing", message: failure.message, httpStatus: 409, retryable: false, origin: "adapter" });
});

test("typed failures preserve their identity in Responses output and diagnostic problems", () => {
  const failure = new ChatGptWebAdapterError("Session could not load", { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true, cause: new Error("Transport closed") });
  const event = adapterErrorEvent(failure);
  expect(event).toMatchObject({ status: 503, code: failure.code, retryable: true });
  expect(buildResponseJSON([event], "chatgpt-web/high").error).toMatchObject({ code: failure.code });
  expect(problemFor(failure)).toMatchObject({ code: failure.code, message: failure.message, httpStatus: 503, retryable: true, causes: [{ code: "Error", message: "Transport closed" }] });
});

test("unknown errors record the missing error contract without manufacturing capacity", () => {
  expect(adapterErrorEvent(new Error("temporarily unavailable"))).toMatchObject({ status: 502, code: "bridge_error" });
  expect(problemFor(new Error("arbitrary private output"))).toMatchObject({ code: "operation_failed", evidenceMissing: expect.any(String) });
});

test("the real response boundary retains typed failures in streamed and buffered output and correlates their diagnostics", async () => {
  for (const stream of [false, true]) {
    const events: DiagnosticEvent[] = [];
    const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "runtime", target: "synthetic", environment: "test" });
    setRuntimeDiagnostics(diagnostics);
    try {
      const config = defaultConfig("browser-only"); config.solAvailable = false; config.proAvailable = false;
      const failure = new ChatGptWebAdapterError("Local browser connection temporarily unavailable", { status: 502, code: "browser_disconnected", errorType: "server_error", retryable: false, cause: new Error("CDP socket closed") });
      const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/luna", stream, input: "synthetic fixture" }) }), config, () => ({ name: "fixture", runTurn: async () => { throw failure; } }));
      const body = await response.text();
      expect(body).toContain("browser_disconnected"); expect(body).not.toContain("server_is_overloaded");
      const problem = events.find(event => event.kind === "problem");
      expect(problem?.problem).toMatchObject({ code: "browser_disconnected", causes: [{ code: "Error", message: "CDP socket closed" }] });
      expect(events.find(event => event.name === "adapter.turn" && event.span?.endTime !== undefined)).toMatchObject({ traceId: problem?.traceId, span: { outcome: "failed" } });
    } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
  }
});

test("an adapter without terminal evidence is recorded as unknown instead of successful", async () => {
  const events: DiagnosticEvent[] = [];
  const diagnostics = new Diagnostics({ emit: event => events.push(event) }, { component: "runtime", target: "synthetic", environment: "test" });
  setRuntimeDiagnostics(diagnostics);
  try {
    const config = defaultConfig("browser-only"); config.solAvailable = false; config.proAvailable = false;
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "chatgpt-web/luna", stream: false, input: "synthetic fixture" }) }), config, () => ({ name: "fixture", runTurn: async () => {} }));
    await response.text();
    expect(events.find(event => event.name === "adapter.turn" && event.span?.endTime !== undefined)?.span?.outcome).toBe("unknown");
  } finally { setRuntimeDiagnostics(undefined); await diagnostics.close(); }
});
