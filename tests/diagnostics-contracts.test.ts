import { expect, test } from "bun:test";
import { DiagnosticEventSchema, ProblemSchema, QuerySchema } from "../src/diagnostics/contracts";
import { safeAttributes, safeText, sanitizeEvent } from "../src/diagnostics/privacy";

test("diagnostic contracts reject malformed identities and executable recovery actions", () => {
  expect(ProblemSchema.safeParse({ code: "failure", message: "Oops", actions: ["execute-shell"] }).success).toBe(false);
  expect(QuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
  expect(DiagnosticEventSchema.safeParse({ traceId: "task-not-a-trace" }).success).toBe(false);
});
test("record variants require their evidence and terminal outcomes require a completion time", () => {
  const base = { version: 1, id: crypto.randomUUID(), time: Date.now(), name: "fixture", severity: "info", body: "Fixture", component: "test", environment: "test", target: "fixture", attributes: {} };
  expect(DiagnosticEventSchema.safeParse({ ...base, kind: "problem" }).success).toBe(false);
  expect(DiagnosticEventSchema.safeParse({ ...base, kind: "span", span: { startTime: 1, outcome: "running" } }).success).toBe(false);
  expect(DiagnosticEventSchema.safeParse({ ...base, kind: "span", traceId: "a".repeat(32), spanId: "b".repeat(16), span: { startTime: 1, outcome: "succeeded" } }).success).toBe(false);
});
test("normal events omit private data before persistence, exports remove user identity", () => {
  const attributes = safeAttributes({ prompt: "private prompt", response: "private response", cookie: "abc", responseChars: 32, password: "abc", durationMs: 14, status: "ready" });
  expect(attributes).toEqual({ responseChars: 32, durationMs: 14, status: "ready" });
  expect(safeText("Failed with Bearer abc123 and sk-secret12345")).not.toContain("abc123");
  expect(safeText("locator.click: <div>private title</div>")).not.toContain("private title");
  const event = sanitizeEvent({ version: 1, id: crypto.randomUUID(), time: Date.now(), kind: "log", name: "test", severity: "info", body: "See /home/alice/config", component: "test", environment: "test", target: "/home/alice", taskName: "Private task", attributes: { path: "/home/alice/config" } }, true);
  expect(JSON.stringify(event)).not.toContain("alice");
  expect(JSON.stringify(event)).not.toContain("Private task");
});
