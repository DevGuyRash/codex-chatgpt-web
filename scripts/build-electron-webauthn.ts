import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "native/electron/manifest.json"), "utf8")) as {
  electronCommit: string; chromiumCommit: string; buildToolsCommit: string; buildConfig: string;
  gnArgs: string[]; patch: string; chromiumPatch: string; chromiumCssPatch: string;
  libnotifyHeaders: { version: string; sha256: Record<string, string> };
};
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const source = process.env.CODEX_WEB_GPT_ELECTRON_SOURCE;
const tools = process.env.CODEX_WEB_GPT_ELECTRON_BUILD_TOOLS;
if (!source || !tools || !source.startsWith("/") || !tools.startsWith("/")) {
  throw new Error("Set absolute CODEX_WEB_GPT_ELECTRON_SOURCE and CODEX_WEB_GPT_ELECTRON_BUILD_TOOLS paths");
}
const patch = resolve(root, "native/electron", manifest.patch);
const chromiumPatch = resolve(root, "native/electron", manifest.chromiumPatch);
const chromiumCssPatch = resolve(root, "native/electron", manifest.chromiumCssPatch);
const chromiumRoot = resolve(source, "..");
// Electron's npm preflight must use the native npm. Workspace PATH interceptors can route
// npm into unrelated read-only caches before the selected build root is reached.
const gnTools = resolve(source, "..", "buildtools/linux64");
const buildPath = process.platform === "linux"
  ? `/usr/bin:/bin:${gnTools}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` : process.env.PATH;
const result = (command: string, args: string[], cwd: string, quiet = false) => spawnSync(command, args, {
  cwd, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", shell: false,
  env: { ...process.env, PATH: buildPath, BUILD_TOOLS_SHA: manifest.buildToolsCommit, ELECTRON_BUILD_TOOLS_ROOT: tools },
});
const revision = result("git", ["rev-parse", "HEAD"], source, true);
if (revision.status !== 0 || revision.stdout.trim() !== manifest.electronCommit) {
  throw new Error("Electron source is not the pinned reviewed revision");
}
// Electron applies its pinned Chromium patch list as local commits during e sync. Their
// commit IDs include local committer metadata, so verify the public base plus the exact
// pinned patch-list length instead of treating a generated HEAD as a stable revision.
const chromiumBase = result("git", ["merge-base", "--is-ancestor", manifest.chromiumCommit, "HEAD"], chromiumRoot, true);
const patchList = resolve(source, "patches/chromium/.patches");
const electronPatches = readFileSync(patchList, "utf8").trim().split("\n").filter(Boolean);
const patchListClean = result("git", ["diff", "--quiet", "HEAD", "--", "patches/chromium"], source, true);
const chromiumPatchCount = result("git", ["rev-list", "--count", `${manifest.chromiumCommit}..HEAD`], chromiumRoot, true);
if (chromiumBase.status !== 0 || patchListClean.status !== 0
  || chromiumPatchCount.status !== 0 || Number(chromiumPatchCount.stdout.trim()) !== electronPatches.length) {
  throw new Error("Chromium source does not match the pinned base and Electron patch stack");
}
const toolRevision = result("git", ["rev-parse", "HEAD"], tools, true);
if (toolRevision.status !== 0 || toolRevision.stdout.trim() !== manifest.buildToolsCommit) {
  throw new Error("Electron build-tools are not the pinned revision");
}
if (result("git", ["apply", "--reverse", "--check", patch], source, true).status !== 0) {
  if (result("git", ["apply", "--check", patch], source).status !== 0
    || result("git", ["apply", patch], source).status !== 0) {
    throw new Error("The reviewed Electron WebAuthn patch did not apply cleanly");
  }
}
if (result("git", ["apply", "--reverse", "--check", chromiumPatch], chromiumRoot, true).status !== 0) {
  if (result("git", ["apply", "--check", chromiumPatch], chromiumRoot).status !== 0
    || result("git", ["apply", chromiumPatch], chromiumRoot).status !== 0) {
    throw new Error("The reviewed Chromium hybrid-discovery patch did not apply cleanly");
  }
}
if (result("git", ["apply", "--reverse", "--check", chromiumCssPatch], chromiumRoot, true).status !== 0) {
  if (result("git", ["apply", "--check", chromiumCssPatch], chromiumRoot).status !== 0
    || result("git", ["apply", chromiumCssPatch], chromiumRoot).status !== 0) {
    throw new Error("The reviewed Chromium CSS fallback patch did not apply cleanly");
  }
}
const configPath = resolve(tools, "configs", "evm." + manifest.buildConfig + ".json");
const config = JSON.parse(readFileSync(configPath, "utf8")) as { root: string; gen: { out: string; args: string[] } };
if (resolve(config.root, "src/electron") !== resolve(source) || config.gen.out !== "Release"
  || JSON.stringify(config.gen.args) !== JSON.stringify(manifest.gnArgs)) {
  throw new Error("Electron release build configuration points outside the pinned source");
}
const headerFiles = Object.entries(manifest.libnotifyHeaders.sha256);
if (process.platform === "linux" && (manifest.libnotifyHeaders.version !== "0.8.8" || headerFiles.length !== 5)) {
  throw new Error("The pinned Linux libnotify header set is incomplete");
}
for (const [name, expectedHash] of process.platform === "linux" ? headerFiles : []) {
  if (!/^[a-z-]+\.h$/.test(name) || !/^[a-f0-9]{64}$/.test(expectedHash)
    || sha256(resolve(root, "native/electron/libnotify-headers/libnotify", name)) !== expectedHash) {
    throw new Error(`The reviewed libnotify header is missing or changed: ${name}`);
  }
}
if (process.argv.includes("--prepare-only")) {
  console.log("Pinned Electron source, build tools, and WebAuthn patch are ready.");
  process.exit(0);
}
const entry = resolve(tools, "dist/e.js");
const jobs = Number(process.env.CODEX_WEB_GPT_ELECTRON_JOBS ?? 8);
if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 24) {
  throw new Error("CODEX_WEB_GPT_ELECTRON_JOBS must be an integer from 1 to 24");
}
if (result("node", [entry, "use", manifest.buildConfig], tools).status !== 0) {
  throw new Error("Could not activate the reviewed Electron build configuration");
}
if (process.platform === "linux") {
  const chromiumRoot = resolve(config.root, "src");
  const output = resolve(chromiumRoot, "out/Release");
  const gn = resolve(chromiumRoot, "buildtools/linux64/gn");
  const sysrootHeaders = resolve(chromiumRoot, "build/linux/debian_bullseye_amd64-sysroot/usr/include/libnotify");
  mkdirSync(sysrootHeaders, { recursive: true });
  for (const [name, expectedHash] of headerFiles) {
    const destination = resolve(sysrootHeaders, name);
    if (existsSync(destination) && sha256(destination) !== expectedHash) {
      throw new Error(`The Electron sysroot has a conflicting libnotify header: ${name}`);
    }
    if (!existsSync(destination)) {
      writeFileSync(destination, readFileSync(resolve(root, "native/electron/libnotify-headers/libnotify", name)), { mode: 0o644 });
    }
  }
  writeFileSync(resolve(output, "args.gn"), `${manifest.gnArgs.join("\n")}\n`);
  if (result(gn, ["gen", "out/Release"], chromiumRoot).status !== 0) {
    throw new Error("Could not generate the reviewed Electron release configuration");
  }
  const resolvedArgs = result(gn, ["args", "out/Release", "--list", "--short"], chromiumRoot, true);
  if (resolvedArgs.status !== 0 || !/^is_debug = false$/m.test(resolvedArgs.stdout)
    || !/^symbol_level = 0$/m.test(resolvedArgs.stdout)
    || !/^v8_enable_verification_features = false$/m.test(resolvedArgs.stdout)) {
    throw new Error("Electron GN output did not resolve to the reviewed non-debug release build");
  }
}
if (result("node", [entry, "build", "--target", "electron:electron_dist_zip", "--", "-j" + jobs], tools).status !== 0) {
  throw new Error("The patched Electron runtime build failed");
}
const dist = resolve(config.root, "src/out/Release/dist.zip");
const binary = resolve(config.root, "src/out/Release", process.platform === "darwin"
  ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
writeFileSync(resolve(config.root, "src/out/Release/codex-web-gpt-webauthn-build.json"), JSON.stringify({
  version: 1,
  electronCommit: manifest.electronCommit,
  chromiumCommit: manifest.chromiumCommit,
  buildToolsCommit: manifest.buildToolsCommit,
  patchSha256: sha256(patch),
  chromiumPatchSha256: sha256(chromiumPatch),
  chromiumCssPatchSha256: sha256(chromiumCssPatch),
  libnotifyHeaders: manifest.libnotifyHeaders,
  distSha256: sha256(dist),
  binarySha256: sha256(binary),
}) + "\n", { mode: 0o600 });
