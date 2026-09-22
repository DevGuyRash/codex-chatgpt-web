import { expect, test } from "bun:test";
import { ActionController } from "../launcher/src/actions/controller";
import { groupNotices, noticePolicy } from "../launcher/src/actions/policy";
import { selectDiagnosticRow } from "../launcher/src/diagnostics/selection";

test("routine reads stay quiet but their failures remain actionable", async () => {
  const actions = new ActionController();
  await actions.run("group", async () => ({}));
  expect(groupNotices(actions.getSnapshot())).toEqual([]);
  await actions.run("group", async () => { throw new Error("test"); });
  expect(groupNotices(actions.getSnapshot())).toHaveLength(1);
  expect(noticePolicy(actions.getSnapshot()[0]).timeout).toBeUndefined();
});

test("repeated confirmations group without losing occurrence history, and dismissal keeps that history", async () => {
  const actions = new ActionController();
  await actions.run("copy", async () => ({})); await actions.run("copy", async () => ({}));
  const group = groupNotices(actions.getSnapshot())[0];
  expect(group.count).toBe(2); expect(noticePolicy(group.notice).timeout).toBe(5000);
  for (const id of group.ids) actions.dismiss(id);
  expect(actions.getSnapshot()).toHaveLength(2);
  expect(actions.getSnapshot().every(notice => notice.dismissedAt !== undefined)).toBe(true);
});

test("background settlements retain separate occurrences unless they name the same operation", () => {
  const actions = new ActionController();
  actions.complete("runtime-recovery", { status: "succeeded" }); actions.complete("runtime-recovery", { status: "succeeded" });
  expect(groupNotices(actions.getSnapshot())[0].count).toBe(2);
  actions.complete("runtime-recovery", { status: "failed", traceId: "a".repeat(32) });
  actions.complete("runtime-recovery", { status: "failed", traceId: "a".repeat(32) });
  expect(actions.getSnapshot()).toHaveLength(3);
});

test("range selection supports additive ranges and toggles without changing the anchor", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const range = selectDiagnosticRow(new Set(["a"]), ids, "e", "c", { shift: true, additive: true });
  expect([...range.selected]).toEqual(["a", "c", "d", "e"]); expect(range.anchor).toBe("c");
  expect([...selectDiagnosticRow(range.selected, ids, "d", range.anchor, { shift: false, additive: true }).selected]).toEqual(["a", "c", "e"]);
});
