import { expect, test } from "bun:test";
import { setTomlScalar } from "../src/toml-edit";

test("changes only the owned scalar, preserving comments, alignment, and mixed endings", () => {
  const text = '# user\r\n[features]\n  "multi_agent"   = false # keep\r\ncontext_management = { experimental_mode = true }\n';
  expect(setTomlScalar(text, ["features", "multi_agent"], true)).toBe(text.replace("= false", "= true"));
});

test("updates a dotted quoted key inside nested inline tables", () => {
  const text = 'features = { "multi_agent_v2" = { enabled = true, concurrency = 6 }, other = "keep" }\n';
  expect(setTomlScalar(text, ["features", "multi_agent_v2", "enabled"], false)).toBe(text.replace("enabled = true", "enabled = false"));
});

test("does not mistake multiline string contents for configuration", () => {
  const text = 'note = """\n[features]\nmulti_agent = false\n"""\n[features]\nmulti_agent = false\n';
  expect(setTomlScalar(text, ["features", "multi_agent"], true)).toBe(text.slice(0, -6) + 'true\n');
});

test("inserts missing keys within the existing table or inline table", () => {
  const inline = 'features = { multi_agent_v2 = { concurrency = 6 } }\n';
  const result = setTomlScalar(inline, ["features", "multi_agent_v2", "enabled"], false);
  expect(Bun.TOML.parse(result)).toEqual({ features: { multi_agent_v2: { concurrency: 6, enabled: false } } });
  expect(result).toContain("concurrency = 6");
  const regular = '[features]\nother = true\n[agents]\nmax_depth = 2\n';
  expect(Bun.TOML.parse(setTomlScalar(regular, ["features", "multi_agent"], true))).toEqual({ features: { other: true, multi_agent: true }, agents: { max_depth: 2 } });
});

test("inserts a missing root table path without changing existing tables", () => {
  const text = '[agents]\nmax_depth = 2';
  expect(Bun.TOML.parse(setTomlScalar(text, ["features", "multi_agent"], true))).toEqual({ features: { multi_agent: true }, agents: { max_depth: 2 } });
});

test("equivalent scalar representations are left byte-for-byte unchanged", () => {
  const text = '[agents]\nmax_depth = 0x02 # keep\n';
  expect(setTomlScalar(text, ["agents", "max_depth"], 2)).toBe(text);
});

test("rejects duplicate TOML without quoting private values", () => {
  expect(() => setTomlScalar('secret="PRIVATE_CANARY"\na=1\na=2', ["a"], 3)).toThrow("Invalid TOML");
});

test("does not replace a table or traverse a scalar to add a setting", () => {
  expect(() => setTomlScalar('features = { other = true }', ["features"], false)).toThrow();
  expect(() => setTomlScalar('features = false', ["features", "multi_agent"], true)).toThrow();
});

test("removes only the selected inline scalar, leaving its siblings", () => {
  for (const text of ['features={v2={enabled=false, concurrency=6}}', 'features={v2={concurrency=6, enabled=false}}', 'features={v2={enabled=false}}']) {
    const result = setTomlScalar(text, ["features", "v2", "enabled"], undefined);
    const expected = Bun.TOML.parse(text) as { features: { v2: { enabled?: boolean } } };
    delete expected.features.v2.enabled;
    expect(Bun.TOML.parse(result)).toEqual(expected);
  }
});

test("removing a scalar preserves surrounding comments and a BOM", () => {
  const text = '\uFEFF[features]\r\nflag = true # user comment\r\nother = false\r\n';
  expect(setTomlScalar(text, ["features", "flag"], undefined)).toBe(text.replace("flag = true", ""));
});
