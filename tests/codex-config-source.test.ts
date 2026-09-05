import { expect, test } from "bun:test";
import { boundCodexRouteSection, inspectCodexConfigSource, ROUTES_BEGIN, ROUTES_END, setTrackedCodexScalar } from "../src/codex-config-source";
import { parseTomlValue } from "../src/toml-edit";
import { describeCodexSourceChange } from "../src/codex-configuration-plan";

for (const ending of ["\n", "\r\n", "\r"]) test(`bounded routes preserve source and siblings (${JSON.stringify(ending)})`, () => {
  const original = '\uFEFF"openai_base_url" = "local" # explanation' + ending + 'other = true' + ending + 'experimental_realtime_webrtc_call_base_url = "voice"' + ending + '[features]' + ending + 'context_management = true' + ending;
  const result = boundCodexRouteSection(original);
  expect(parseTomlValue(result)).toEqual(parseTomlValue(original));
  expect(result.startsWith('\uFEFF' + ROUTES_BEGIN + ending)).toBe(true);
  expect(result).toContain('"openai_base_url" = "local" # explanation' + ending);
  expect(boundCodexRouteSection(result)).toBe(result);
  expect(inspectCodexConfigSource(result).conflicts).toEqual([]);
  const change = describeCodexSourceChange("config.toml", original, result)[0]!;
  expect(original.replace(change.before, change.after)).toBe(result);
});

test("empty bounded section receives routes inside its boundaries", () => {
  let text = `${ROUTES_BEGIN}\n${ROUTES_END}\n[features]\nother=true\n`;
  text = setTrackedCodexScalar(text, ["openai_base_url"], "local");
  text = setTrackedCodexScalar(text, ["experimental_realtime_webrtc_call_base_url"], "voice");
  expect(boundCodexRouteSection(text)).toBe(text);
  expect(inspectCodexConfigSource(text).assignments.filter(item => item.section === "routes")).toHaveLength(2);
});

test("source change describes fresh files and final newline changes exactly", () => {
  expect(describeCodexSourceChange("config", "", "new\n")).toEqual([{ path: "config", startLine: 1, before: "", after: "new\n" }]);
  expect(describeCodexSourceChange("config", "one\r\ntwo", "one\r\ntwo\r\n")).toEqual([{ path: "config", startLine: 2, before: "two", after: "two\r\n" }]);
});

test("commented assignments have their actual table scope and ignore string examples", () => {
  const text = 'example = """\n# openai_base_url = "example"\n"""\n[features]\n# multi_agent = false\n';
  expect(inspectCodexConfigSource(text).assignments.filter(item => item.state === "commented_out"))
    .toMatchObject([{ path: ["features", "multi_agent"], value: false, line: 5 }]);
});

test("approved edits reactivate the unique tracked line and preserve comments and CRLF", () => {
  const text = `${ROUTES_BEGIN}\r\n# "openai_base_url"   = "old" # keep explanation\r\n${ROUTES_END}\r\n`;
  const changed = setTrackedCodexScalar(text, ["openai_base_url"], "new");
  expect(changed).toBe(`${ROUTES_BEGIN}\r\n"openai_base_url"   = "new" # keep explanation\r\n${ROUTES_END}\r\n`);
  expect(parseTomlValue(changed)).toEqual({ openai_base_url: "new" });
});

for (const [name, text] of [
  ["missing end", `${ROUTES_BEGIN}\n# openai_base_url="old"\n`],
  ["stray end", `${ROUTES_END}\n`],
  ["duplicate sections", `${ROUTES_BEGIN}\n${ROUTES_END}\n${ROUTES_BEGIN}\n${ROUTES_END}\n`],
  ["nested sections", `${ROUTES_BEGIN}\n${ROUTES_BEGIN}\n${ROUTES_END}\n${ROUTES_END}\n`],
  ["outside key", `openai_base_url="outside"\n${ROUTES_BEGIN}\n${ROUTES_END}\n`],
  ["wrong scope", `[features]\n${ROUTES_BEGIN}\n${ROUTES_END}\n`],
  ["crossed table", `${ROUTES_BEGIN}\n[features]\n${ROUTES_END}\n`],
  ["duplicate active keys", `openai_base_url="one"\n"openai_base_url"="two"\n`],
] as const) test(`${name} prevents guessing which configuration source to edit`, () => {
  expect(inspectCodexConfigSource(text).conflicts.length).toBeGreaterThan(0);
  expect(() => setTrackedCodexScalar(text, ["openai_base_url"], "new")).toThrow();
});

test("markers in multiline strings are not tracked sections", () => {
  expect(inspectCodexConfigSource(`example='''\n${ROUTES_BEGIN}\n'''\n`).conflicts).toEqual([]);
});

test("competing commented tracked assignments are not automatically consolidated", () => {
  const text = `${ROUTES_BEGIN}\n# openai_base_url="one"\n# openai_base_url="two"\n${ROUTES_END}\n`;
  expect(() => setTrackedCodexScalar(text, ["openai_base_url"], "new")).toThrow("Multiple commented assignments");
});
