import { expect, test } from "bun:test";
import { discoverConfigurationSource, resolveConfigurationSource } from "../src/codex-config-occurrences";
import { parseTomlValue } from "../src/toml-edit";

test("bounded route consolidation moves only routes and retains unrelated active contents", () => {
  const original = '# BEGIN codex-chatgpt-web: routes\nopenai_base_url="one"\n# END codex-chatgpt-web: routes\n# BEGIN codex-chatgpt-web: routes\nexperimental_realtime_webrtc_call_base_url="voice"\nkeep="untouched"\n# END codex-chatgpt-web: routes\n';
  const source = discoverConfigurationSource(original);
  const sections = source.occurrences.filter(item => item.kind === "route-section");
  expect(sections).toHaveLength(2);
  const resolved = resolveConfigurationSource(original, [{ occurrenceId: sections[0]!.id }]);
  expect(resolved).toContain('keep="untouched"');
  expect(resolved).not.toContain('# keep="untouched"');
  expect(resolved).toContain('# # BEGIN codex-chatgpt-web: routes');
  expect(resolved).toContain('# experimental_realtime_webrtc_call_base_url="voice"');
  expect(discoverConfigurationSource(resolved).valid).toBe(true);
  expect(discoverConfigurationSource(resolved).occurrences.filter(item => item.kind === "route-section")).toHaveLength(1);
});

test("discovery distinguishes quoted dotted keys, table scope, comments and multiline examples", () => {
  const text = 'example = """\nopenai_base_url="fake"\n[features]\n"""\n"features.multi_agent" = 1\n[features]\n# multi_agent = true\nmulti_agent=false\n';
  const source = discoverConfigurationSource(text);
  expect(source.complete).toBe(true);
  expect(source.valid).toBe(true);
  expect(source.occurrences.filter(item => item.kind === "assignment").map(item => [item.path, item.line, item.state])).toEqual([
    [["example"], 1, "active"], [["features.multi_agent"], 5, "active"],
    [["features", "multi_agent"], 7, "commented_out"], [["features", "multi_agent"], 8, "active"],
  ]);
});

test("multiline string continuations retain source line numbers", () => {
  const source = discoverConfigurationSource('example = """one\\\n two"""\nopenai_base_url="real"\n');
  expect(source.occurrences.at(-1)?.line).toBe(3);
});

test("legitimate arrays of hooks have distinct identities", () => {
  const source = discoverConfigurationSource('[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ncommand="one"\n[[hooks.Interrupt.hooks]]\ncommand="two"\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ncommand="three"\n');
  expect(source.valid).toBe(true);
  expect(source.occurrences.filter(item => item.kind === "assignment").map(item => item.path)).toEqual([
    ["hooks", "Interrupt", 0, "hooks", 0, "command"], ["hooks", "Interrupt", 0, "hooks", 1, "command"],
    ["hooks", "Interrupt", 1, "hooks", 0, "command"],
  ]);
});

for (const ending of ["\n", "\r\n", "\r"]) test(`resolving a duplicate preserves disabled content and line endings ${JSON.stringify(ending)}`, () => {
  const text = ['\uFEFFopenai_base_url="one" # keep', 'openai_base_url="two"', 'unrelated=true', ''].join(ending);
  const source = discoverConfigurationSource(text);
  const result = resolveConfigurationSource(text, [{ occurrenceId: source.occurrences[1]!.id }]);
  expect(result).toBe(['\uFEFF# openai_base_url="one" # keep', 'openai_base_url="two"', 'unrelated=true', ''].join(ending));
  expect(parseTomlValue(result)).toEqual({ openai_base_url: "two", unrelated: true });
});

test("reactivation disables competing active values without deleting them", () => {
  const text = '# openai_base_url="selected"\nopenai_base_url="old"\n';
  const choice = discoverConfigurationSource(text).occurrences[0]!;
  expect(resolveConfigurationSource(text, [{ occurrenceId: choice.id }])).toBe('openai_base_url="selected"\n# openai_base_url="old"\n');
  expect(() => resolveConfigurationSource(text + "# changed\n", [{ occurrenceId: "stale" }])).toThrow("stale");
});

test("unclosed strings do not invent later assignments or permit resolution", () => {
  const text = 'openai_base_url="first"\nexample="""\nopenai_base_url="not a definition"\n';
  const source = discoverConfigurationSource(text);
  expect(source.complete).toBe(false);
  expect(source.occurrences).toHaveLength(1);
  expect(() => resolveConfigurationSource(text, [{ occurrenceId: source.occurrences[0]!.id }])).toThrow("incomplete");
});

test("commenting a competing multiline value preserves CRLF bytes", () => {
  const text = 'openai_base_url="""one\r\ntwo"""\r\nopenai_base_url="new"\r\n';
  const source = discoverConfigurationSource(text);
  const result = resolveConfigurationSource(text, [{ occurrenceId: source.occurrences[1]!.id }]);
  expect(result).toBe('# openai_base_url="""one\r\n# two"""\r\nopenai_base_url="new"\r\n');
});

test("duplicate table consolidation preserves all settings across intervening unrelated tables", () => {
  const text = '[features]\nmulti_agent=true\n[unrelated]\nkeep="exact" # leave here\n[features]\nmulti_agent_v2=false # preserve\n';
  const source = discoverConfigurationSource(text);
  const header = source.occurrences.find(item => item.kind === "table" && item.path[0] === "features")!;
  const resolved = resolveConfigurationSource(text, [{ occurrenceId: header.id }]);
  expect(parseTomlValue(resolved)).toEqual({ features: { multi_agent: true, multi_agent_v2: false }, unrelated: { keep: "exact" } });
  expect(resolved).toContain('[unrelated]\nkeep="exact" # leave here\n# [features]\n# multi_agent_v2=false # preserve');
});

test("table and assignment choices compose without deduplicating hook arrays", () => {
  const text = '[features]\nmulti_agent=true\n[features]\nmulti_agent=false\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ncommand="one"\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ncommand="two"\n';
  const source = discoverConfigurationSource(text);
  const choice = source.occurrences.filter(item => item.kind === "assignment" && item.path[0] === "features").at(-1)!;
  const header = source.occurrences.find(item => item.kind === "table" && item.path[0] === "features")!;
  const resolved = resolveConfigurationSource(text, [{ occurrenceId: header.id }, { occurrenceId: choice.id }]);
  expect(parseTomlValue(resolved).features).toEqual({ multi_agent: false });
  expect((parseTomlValue(resolved).hooks as { Interrupt: unknown[] }).Interrupt).toHaveLength(2);
  expect(() => resolveConfigurationSource(text, [{ occurrenceId: source.occurrences.find(item => item.kind === "array-table")!.id }])).toThrow("array");
});
