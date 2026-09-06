const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("diagnostic save suggestions include a sortable filename-safe UTC date and time for every format", async () => {
  const main = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  const chooser = main.slice(main.indexOf("  const chooseDiagnosticExport ="), main.indexOf("  registerDiagnosticsIpc({ handle, logger, chooseExport:"));
  let now = "2026-09-06T04:52:31.247Z";
  let options;
  let canceled = false;
  const context = {
    Date: class extends Date { constructor() { super(now); } },
    path, mainWindow: {}, stateStore: { read: () => ({ language: "en" }) },
    nativeCopyFor: () => ({ exportDiagnostics: "Export diagnostics" }),
    app: { getPath: () => "/documents" },
    dialog: { showSaveDialog: async (_window, value) => { options = value; return { canceled, filePath: "/chosen/report.json" }; } },
  };
  vm.createContext(context);
  vm.runInContext(`${chooser}\nthis.choose = chooseDiagnosticExport;`, context);
  for (const [format, extension] of [["bundle", "zip"], ["html", "html"], ["json", "json"], ["otlp", "json"]]) {
    assert.equal(await context.choose(format), "/chosen/report.json");
    assert.equal(path.basename(options.defaultPath), `codex-web-gpt-diagnostics-2026-09-06T04-52-31-247Z.${extension}`);
    assert.equal(options.filters[0].extensions[0], extension);
  }
  const first = options.defaultPath;
  now = "2026-09-06T04:52:31.248Z";
  await context.choose("json");
  assert.notEqual(options.defaultPath, first);
  assert.ok(options.defaultPath > first);
  canceled = true;
  assert.equal(await context.choose("json"), undefined);
});
