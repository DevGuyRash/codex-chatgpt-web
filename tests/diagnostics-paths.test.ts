import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, statSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDestination, containsPath, writeExport } from "../src/diagnostics/paths";
import { exportDiagnostics } from "../src/diagnostics/export";
import { DiagnosticStore } from "../src/diagnostics/store";

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "diagnostics-paths-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("path containment respects Windows drives, case, UNC shares, Unicode, and component boundaries", () => {
  expect(containsPath("C:\\Users\\Someone\\诊断", "c:\\users\\SOMEONE\\诊断\\report.html", "win32")).toBe(true);
  expect(containsPath("C:\\store", "D:\\store\\report.html", "win32")).toBe(false);
  expect(containsPath("C:\\store", "C:\\store-old\\report.html", "win32")).toBe(false);
  expect(containsPath("\\\\server\\share\\store", "\\\\SERVER\\SHARE\\store\\report.html", "win32")).toBe(true);
  expect(containsPath("\\\\server\\share\\store", "\\\\server\\other\\store\\report.html", "win32")).toBe(false);
  expect(containsPath("/store", "/Store/report.html", "linux")).toBe(false);
  expect(containsPath("/store", "/store/../elsewhere/report.html", "linux")).toBe(false);
});
test("atomic export preserves the parent permissions and leaves no temporary files", async () => {
  const path = root(); const directory = join(path, "shared exports 日本語"); mkdirSync(directory, { mode: 0o755 });
  const permissions = statSync(directory).mode;
  const output = join(directory, "report.html");
  await writeExport(output, "first"); await writeExport(output, "replacement");
  expect(readFileSync(output, "utf8")).toBe("replacement");
  expect(statSync(directory).mode).toBe(permissions);
  expect(readdirSync(directory)).toEqual(["report.html"]);
  if (process.platform !== "win32") expect(statSync(output).mode & 0o777).toBe(0o600);
});
test.skipIf(process.platform === "win32")("exports reject a symlink ancestor into private storage, including nonexistent descendants", async () => {
  const path = root(); const directory = join(path, "store"); const store = new DiagnosticStore(directory); store.close();
  const alias = join(path, "alias"); symlinkSync(directory, alias, "dir");
  const output = join(alias, "new", "report.html");
  expect(canonicalDestination(output)).toBe(join(directory, "new", "report.html"));
  await expect(exportDiagnostics(directory, { format: "html" }, output)).rejects.toThrow("must not overwrite");
});
