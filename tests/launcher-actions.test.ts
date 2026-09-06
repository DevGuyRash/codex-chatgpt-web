import { expect, test } from "bun:test";
import { ActionController, launcherActions } from "../launcher/src/actions/controller";
import { withActionFeedback, launcherActionPolicy, observeLauncherOperation } from "../launcher/src/actions/api";
import type { LauncherApi } from "../launcher/src/types";
import { DiagnosticRequestError } from "../src/diagnostics/request-error";
import { createDiagnosticsBridge } from "../launcher/diagnostics/preload";

test("duplicate actions share execution and one terminal notice; chooser cancellation is neutral", async () => {
  const controller = new ActionController();
  let calls = 0, finish!: (value: { cancelled: boolean }) => void;
  const work = () => { calls++; return new Promise<{ cancelled: boolean }>(resolve => { finish = resolve; }); };
  const first = controller.run("export", work), duplicate = controller.run("export", work);
  expect(calls).toBe(1);
  expect(controller.getSnapshot()[0].status).toBe("pending");
  finish({ cancelled: true });
  expect((await first).status).toBe("cancelled");
  expect((await duplicate).status).toBe("cancelled");
  expect(controller.getSnapshot()).toHaveLength(1);
  expect(controller.getSnapshot()[0].status).toBe("cancelled");
});

test("false ok and accepted work do not become successful completion", async () => {
  const controller = new ActionController();
  expect((await controller.run("check", async () => ({ ok: false }))).status).toBe("failed");
  expect((await controller.run("install", async () => ({ accepted: true }))).status).toBe("accepted");
  controller.complete("install", { status: "succeeded" });
  expect(controller.getSnapshot().find(item => item.key === "install")?.status).toBe("succeeded");
});

test("the launcher adapter supports frozen Electron APIs and preserves returned data", async () => {
  let writes = 0;
  const value = { keepRunningOnClose: true };
  const api = Object.freeze({ setPreference: async () => { writes++; return value; }, snapshot: async () => ({}) }) as unknown as LauncherApi;
  const wrapped = withActionFeedback(api);
  expect(withActionFeedback(api)).toBe(wrapped);
  expect(wrapped.snapshot).toBe(api.snapshot);
  expect(Object.is(await wrapped.setPreference("keepRunningOnClose", true), value)).toBe(true);
  expect(writes).toBe(1);
  expect(launcherActionPolicy.setPreference).toBe("work");
  expect(launcherActionPolicy.setSidebarState).toBe("quiet");
});

test("operation failure and awaited API failure share a correlated notice", async () => {
  let reject!: (error: Error) => void;
  const api = withActionFeedback({ setupCore: () => new Promise((_resolve, fail) => { reject = fail; }) } as unknown as LauncherApi);
  const pending = api.setupCore();
  observeLauncherOperation({ name: "core-setup", status: "failed", message: "Fixture failure", problem: { version: 1, code: "setup_preview_stale", message: "Fixture failure", traceId: "a".repeat(32), findings: [], causes: [], actions: ["review-setup"], recovery: "not-started" } });
  expect(launcherActions.getSnapshot().filter(item => item.key === "setupCore")).toHaveLength(1);
  reject(new Error("Fixture failure")); await expect(pending).rejects.toThrow("Fixture failure");
  const notices = launcherActions.getSnapshot().filter(item => item.key === "setupCore");
  expect(notices).toHaveLength(1);
  expect(notices[0].status).toBe("failed");
  expect(notices[0].traceId).toBe("a".repeat(32));
});

test("distinct preference writes are serialized, not mistaken for duplicate clicks", async () => {
  const calls: unknown[][] = [];
  let finish!: () => void;
  const api = withActionFeedback({ setPreference: async (...args: unknown[]) => {
    calls.push(args);
    if (calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    return args;
  } } as unknown as LauncherApi);
  const first = api.setPreference("keepRunningOnClose", true);
  const duplicate = api.setPreference("keepRunningOnClose", true);
  const different = api.setPreference("keepRunningOnClose", false);
  const restored = api.setPreference("keepRunningOnClose", true);
  await Promise.resolve();
  expect(calls).toEqual([["keepRunningOnClose", true]]);
  finish();
  const results: unknown[] = [await first, await duplicate, await different, await restored];
  expect(results).toEqual([["keepRunningOnClose", true], ["keepRunningOnClose", true], ["keepRunningOnClose", false], ["keepRunningOnClose", true]]);
  expect(calls).toEqual([["keepRunningOnClose", true], ["keepRunningOnClose", false], ["keepRunningOnClose", true]]);
});

test("independent group loads do not coalesce merely because their action labels match", async () => {
  const controller = new ActionController();
  let finish!: (value: string) => void;
  const first = controller.run("group", () => new Promise<string>(resolve => { finish = resolve; }), { scope: "one" });
  const second = controller.run("group", async () => "two", { scope: "two" });
  finish("one");
  expect((await first).value).toBe("one");
  expect((await second).value).toBe("two");
});

test("action feedback preserves allowlisted diagnostic failure codes without exposing arbitrary errors", async () => {
  const controller = new ActionController();
  await controller.run("export", async () => { throw new DiagnosticRequestError("export_failed"); });
  expect(JSON.stringify(controller.getSnapshot()[0])).toContain('"errorCode":"export_failed"');
  await controller.run("capture", async () => { throw new Error("private child output"); });
  expect(JSON.stringify(controller.getSnapshot())).not.toContain("private child output");
});

test("renderer unwraps serialized diagnostic failures after the Electron context boundary", async () => {
  const failure = { diagnosticFailure: true, code: "timeout" } as const;
  const bridge = createDiagnosticsBridge({ invoke: async () => structuredClone(failure) } as unknown as Parameters<typeof createDiagnosticsBridge>[0]);
  expect(await bridge.query({})).toEqual(failure);
  const api = withActionFeedback({ diagnostics: bridge } as unknown as LauncherApi);
  await expect(api.diagnostics.query({})).rejects.toThrow("exceeded its time limit");
});
