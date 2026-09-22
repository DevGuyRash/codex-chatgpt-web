import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import { findNativeTuiTitleFailure, NativeTuiTitleFailure, runTuiScenario } from "../scripts/golden/tui-scenarios";
import { createWorkload, materializeWorkload } from "../scripts/golden/workloads";
import { ownedProcessIdentity, type OwnedProcess } from "../scripts/golden/workspace";
import { findNativeScenarioFailure } from "../scripts/golden/structured-scenarios";

test("title identity survives aggregated cleanup and causal failures without matching prose", () => {
  const title = new NativeTuiTitleFailure("native-title-id"), cleanup = new Error("cleanup failed");
  cleanup.cause = cleanup;
  expect(findNativeTuiTitleFailure(new AggregateError([cleanup, new Error("wrapper", { cause: title })]))).toBe(title);
  expect(findNativeTuiTitleFailure(new Error("native_tui_title_failed native-title-id"))).toBeUndefined();
});

for (const outcome of ["completed", "failed-plan", "failed-title", "limited-title"] as const) test.skipIf(!process.env.CODEX_TEST_PROFILE_BINARY || !Bun.which("tmux"))(`native TUI coordinator ${outcome}`, async () => {
  const failedPlan = outcome === "failed-plan", failedTitle = outcome === "failed-title" || outcome === "limited-title";
  const root = mkdtempSync(join(tmpdir(), "golden-tui-scenario-")), home = join(root, "native"), task = join(root, "task");
  mkdirSync(home);
  const workload = createWorkload({ level: 1, seed: "tui-coordinator-fixture", batch: 0 });
  materializeWorkload(task, workload);
  expect(Bun.spawnSync(["git", "-C", task, "init", "-q"]).exitCode).toBe(0);
  const route = CHATGPT_WEB_MODEL_ROUTES[0]!;
  let prompts = 0, titles = 0, titleSettled = false, native: OwnedProcess | undefined;
  const captured: { category: string; text: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (new URL(request.url).pathname !== "/responses") return new Response(null, { status: 404 });
    const body = await request.json();
    const lastUser = body.input?.filter((item: { role?: string }) => item.role === "user").at(-1)?.content?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    const title = lastUser.startsWith("Generate a concise, single-line task title of at most 36 characters");
    const turn = title ? 0 : ++prompts;
    if (title) { titles++; await Bun.sleep(400); titleSettled = true; }
    if (title && outcome === "limited-title") return Response.json({ error: { message: "Synthetic title account limit", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }, { status: 429 });
    if (title && failedTitle) return Response.json({ error: { message: "Synthetic missing trusted environment", type: "invalid_request_error", code: "trusted_codex_environment_missing" } }, { status: 409 });
    if (!title && failedPlan) return Response.json({ error: { message: "Synthetic account rate limit", type: "rate_limit_exceeded", code: "rate_limit_exceeded" } }, { status: 429 });
    async function* output(): AsyncIterable<AdapterEvent> {
      yield { type: "text_delta", text: title ? JSON.stringify({ title: "Synthetic plan execution" }) : turn === 1 ? "<proposed_plan>\n# Synthetic plan\nRead the workload and validate its committed outputs.\n</proposed_plan>" : "Synthetic execution complete.", phase: "final_answer" };
      yield { type: "done", endTurn: true };
    }
    return new Response(bridgeToResponsesSSE(output(), route.slug), { headers: { "content-type": "text/event-stream" } });
  } });
  writeFileSync(join(home, "config.toml"), `[projects.${JSON.stringify(task)}]\ntrust_level="trusted"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${server.port}"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n[analytics]\nenabled=false\n`);
  try {
    const promise = runTuiScenario({ executable: process.env.CODEX_TEST_PROFILE_BINARY!, cwd: task, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }, route, workload, modelProvider: "fixture", signal: new AbortController().signal, timeoutMs: 10000,
      onRecord: async (category, text) => { captured.push({ category, text }); }, checkpoint: value => { native = value.native; },
    });
    if (failedPlan) {
      const failure = await promise.catch(error => error);
      const observed = findNativeScenarioFailure(failure);
      expect(observed, JSON.stringify(captured).slice(-12000)).toBeDefined();
      expect(observed!.code, JSON.stringify(observed!.nativeFailure)).toBe("rate_limit_exceeded");
      expect(observed!.nativeFailure.turns).toHaveLength(1);
      expect(prompts).toBe(1);
      expect(captured.some(record => record.text.includes('"action":"accept-plan"'))).toBeFalse();
    } else if (failedTitle) {
      const failure = await promise.catch(error => error);
      expect(failure.code, JSON.stringify(captured).slice(-12000)).toBe("native_tui_title_failed");
      const frames = captured.filter(record => record.category === "transport").map(record => JSON.parse(record.text));
      const titleThread = frames.find(frame => frame.message?.method === "thread/started" && frame.message.params.thread.ephemeral)?.message.params.thread.id;
      expect(titleThread).toBeString();
      expect(findNativeTuiTitleFailure(failure)?.threadId).toBe(titleThread);
      expect(frames.some(frame => frame.message?.method === "thread/status/changed" && frame.message.params.threadId === titleThread && frame.message.params.status.type === "systemError")).toBeTrue();
      expect(titles).toBe(1);
    } else {
      const result = await promise.catch(error => { throw new Error(`${String(error)}\n${JSON.stringify(captured).slice(-16000)}`); });
      expect(result.status).toBe("completed");
      expect(result.scenario.turns.map(turn => turn.status)).toEqual(["completed", "completed"]);
      expect(new Set(result.scenario.turns.map(turn => turn.id)).size).toBe(2);
      expect(result.scenario.planHashes).toHaveLength(1);
      expect(result.scenario.titleTasks).toEqual([{ threadId: expect.any(String), active: true, idle: true }]);
      expect(result.scenario.titleTasks[0]!.threadId).not.toBe(result.threadId);
      expect(prompts).toBe(2); expect(titles).toBe(1); expect(titleSettled).toBeTrue();
      expect(captured.some(record => record.text.includes('"action":"accept-plan"'))).toBeTrue();
    }
  } finally {
    await server.stop(true); rmSync(root, { recursive: true, force: true });
    if (native) expect(ownedProcessIdentity(native.pid)?.start).not.toBe(native.start);
  }
}, 45000);
