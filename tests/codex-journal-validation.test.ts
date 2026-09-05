import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";
import { readJournal } from "../src/codex-integration-journal";
import { getCodexJournalPath, getCodexJournalRecoveryPath } from "../src/codex-integration-shared";

function fixture(run: (journal: Record<string, unknown>, paths: string[]) => void) {
  const root = mkdtempSync(join(tmpdir(), "cgw-journal-validation-"));
  const previousCodex = process.env.CODEX_HOME;
  const previousApp = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  try {
    installCodexIntegration(defaultConfig("browser-only"));
    const paths = [getCodexJournalPath(), getCodexJournalRecoveryPath()];
    run(JSON.parse(readFileSync(paths[0]!, "utf8")), paths);
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodex;
    if (previousApp === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME; else process.env.CODEX_CHATGPT_WEB_HOME = previousApp;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const version of [8, 9, 10]) {
  for (const [name, mutate] of [
    ["missing routing baselines", (journal: Record<string, unknown>) => { journal.previous = {}; }],
    ["array instead of feature baseline", (journal: Record<string, unknown>) => { journal.previousMultiAgent = []; }],
    ["missing depth ownership", (journal: Record<string, unknown>) => { journal.previousAgentMaxDepth = {}; }],
    ["untyped prior feature value", (journal: Record<string, unknown>) => { journal.previousMultiAgentV2 = { present: true, tablePresent: true, rawLine: "enabled = false", value: 42 }; }],
    ["missing installed route", (journal: Record<string, unknown>) => { delete (journal.installed as Record<string, unknown>).openai_base_url; }],
    ["baseline source for a different setting", (journal: Record<string, unknown>) => { (journal.previous as Record<string, unknown>).openai_base_url = { present: true, rawLine: 'model = "unexpected"', value: "old-endpoint" }; }],
  ] as const) {
    test(`v${version} refuses ${name} without healing either journal`, () => fixture((journal, paths) => {
      journal.version = version;
      mutate(journal);
      const text = JSON.stringify(journal);
      for (const path of paths) writeFileSync(path, text);
      expect(() => readJournal({ repair: false })).toThrow("Invalid Codex integration journal");
      for (const path of paths) expect(readFileSync(path, "utf8")).toBe(text);
    }));
  }
}

test("journal parse failures do not quote private source text", () => fixture((_journal, paths) => {
  for (const path of paths) writeFileSync(path, '{"private":"JOURNAL_PRIVATE_CANARY",INVALID}');
  let message = "";
  try { readJournal({ repair: false }); } catch (error) { message = String(error); }
  expect(message).toContain("Invalid Codex integration journal");
  expect(message).not.toContain("JOURNAL_PRIVATE_CANARY");
}));
