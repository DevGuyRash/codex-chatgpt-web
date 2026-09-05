import { expect, test } from "bun:test";
import { alignConfigurationDiff, diffSections } from "../launcher/src/configuration-diff";

test("distant changes retain three context lines and expandable exact middle text", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
  const after = before.replace("line 1\n", "changed one\n").replace("line 28\n", "changed two\n");
  const rows = alignConfigurationDiff(before, after, 5);
  expect(rows.filter(row => row.changed)).toHaveLength(2);
  expect(rows[1]).toEqual({ before: "line 1\n", after: "changed one\n", oldLine: 6, newLine: 6, changed: true });
  const sections = diffSections(rows);
  expect(sections.map(section => [section.omitted, section.rows.length])).toEqual([[false, 5], [true, 20], [false, 5]]);
  expect(rows.map(row => row.before ?? "").join("")).toBe(before);
  expect(rows.map(row => row.after ?? "").join("")).toBe(after);
});

test("insertions do not shift the unchanged source alignment", () => {
  const rows = alignConfigurationDiff("a\nb\n", "added\na\nb\n");
  expect(rows[0]).toEqual({ after: "added\n", newLine: 1, changed: true });
  expect(rows[1]).toEqual({ before: "a\n", after: "a\n", oldLine: 1, newLine: 2, changed: false });
});
