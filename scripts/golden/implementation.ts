import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiagnosticError } from "../../src/diagnostics/problems";

/** Source identity and deployed identity can both be known while describing different builds. */
export function verifyGoldenBrowserHelper(repository: string, helperPath: string) {
  const root = mkdtempSync(join(tmpdir(), "golden-helper-build-")), output = join(root, "browser-helper.cjs");
  try {
    const build = spawnSync(process.execPath, ["run", resolve(repository, "scripts/build-browser-helper.ts"), output], { cwd: repository, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (build.status !== 0) throw new DiagnosticError({ code: "golden_helper_build_failed", message: "The canonical browser helper build did not complete; live admission is unavailable" });
    if (!lstatSync(helperPath).isFile()) throw new Error("The deployed browser helper is not a regular file");
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const sha256 = digest(output);
    if (digest(helperPath) !== sha256) throw new DiagnosticError({ code: "golden_browser_helper_stale", message: "The deployed browser helper does not match the current canonical source build; rebuild it before live admission" });
    return { helperPath: resolve(helperPath), sha256 };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Hash executable source and selected runtime artifacts, including uncommitted work. */
export function goldenImplementationIdentity(repository: string, runtimeArtifacts: readonly string[] = []) {
  const listed = spawnSync("git", ["-C", repository, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error("Golden implementation identity requires its source checkout");
  const paths = [...new Set(listed.stdout.split("\0").filter(path => /^(?:src|scripts|launcher\/(?:electron|diagnostics|src|scripts))\/.+\.(?:ts|tsx|js|cjs|json)$/.test(path) || /^(?:native\/electron|launcher\/patches)\/.+\.(?:patch|json|h)$/.test(path) || /^(?:launcher\/)?(?:package\.json|bun\.lock|tsconfig\.json)$/.test(path)))].sort();
  if (!paths.some(path => path.startsWith("src/")) || !paths.some(path => path.startsWith("scripts/golden/"))) throw new Error("The source checkout lacks golden implementation inputs");
  const records = [...paths.map(path => ({ name: path, path: resolve(repository, path), mayBeDeleted: true })), ...runtimeArtifacts.map(path => ({ name: `runtime:${resolve(path)}`, path: resolve(path), mayBeDeleted: false }))].map(input => {
    let stat;
    try { stat = lstatSync(input.path); }
    catch (error) {
      if (input.mayBeDeleted && (error as NodeJS.ErrnoException).code === "ENOENT") return { name: input.name, deleted: true as const };
      throw error;
    }
    if (!stat.isFile()) throw new Error("Golden implementation inputs must be regular files");
    return { name: input.name, bytes: stat.size, sha256: createHash("sha256").update(readFileSync(input.path)).digest("hex") };
  });
  return { sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"), records };
}
