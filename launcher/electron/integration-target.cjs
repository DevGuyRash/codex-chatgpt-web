const { createHash } = require("node:crypto");
const { existsSync, readdirSync, realpathSync, lstatSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");

function canonicalConfigurationPath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Configuration paths must be nonempty strings");
  const expanded = value === "~" ? homedir() : /^~[/\\]/.test(value) ? join(homedir(), value.slice(2)) : value;
  const absolute = resolve(expanded);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalConfigurationPath(parent), basename(absolute));
}

function resolveIntegrationTarget(options = {}) {
  if (options.profile !== undefined && (typeof options.profile !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(options.profile))) throw new Error("Codex profile names may contain 1–64 letters, numbers, hyphens, and underscores");
  const codexHome = canonicalConfigurationPath(options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")));
  const runtimeRoot = canonicalConfigurationPath(options.runtimeRoot ?? (process.env.CODEX_CHATGPT_WEB_HOME?.trim() || join(homedir(), ".codex-chatgpt-web")));
  const source = join(codexHome, options.profile ? `${options.profile}.config.toml` : "config.toml");
  let linked = false;
  try { linked = lstatSync(source).isSymbolicLink(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (linked || canonicalConfigurationPath(source) !== source) throw new Error("Configuration target aliases a file managed elsewhere; inspect it without changing ownership");
  const id = createHash("sha256").update(JSON.stringify([codexHome, options.profile ?? null])).digest("hex").slice(0, 24);
  return { id, kind: options.profile ? "profile" : "base", codexHome, configPath: source,
    ...(options.profile ? { profile: options.profile } : {}), runtimeHome: options.profile ? join(runtimeRoot, "targets", id) : runtimeRoot };
}

function listIntegrationTargets(options = {}) {
  return discoverIntegrationTargets(options).entries.flatMap(entry => entry.target ? [entry.target] : []);
}

function discoverIntegrationTargets(options = {}) {
  const entries = [];
  const issues = [];
  let codexHome;
  try { codexHome = canonicalConfigurationPath(options.codexHome ?? (process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"))); }
  catch { return { entries, issues: [{ code: "target_home_unavailable" }] }; }
  let names = [];
  try { names = readdirSync(codexHome).filter(name => name !== "config.toml" && name.endsWith(".config.toml")).sort(); }
  catch (error) { if (error.code !== "ENOENT") issues.push({ code: "target_directory_unavailable", path: codexHome }); }
  for (const name of ["config.toml", ...names]) {
    const profile = name === "config.toml" ? undefined : name.slice(0, -12);
    const configPath = join(codexHome, name);
    const entry = { id: createHash("sha256").update(JSON.stringify([codexHome, profile ?? null])).digest("hex").slice(0, 24),
      kind: profile === undefined ? "base" : "profile", ...(profile === undefined ? {} : { profile }), codexHome, configPath, status: "available" };
    try {
      if (profile !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
        entry.status = "unsupported"; entry.code = "target_name_unsupported";
      } else {
        let file;
        try { file = lstatSync(configPath); } catch (error) { if (error.code !== "ENOENT" || profile !== undefined) throw error; }
        if (file?.isSymbolicLink()) {
          entry.resolvedPath = realpathSync.native(configPath);
          if (!statSync(configPath).isFile()) throw new Error("Not a configuration file");
          entry.status = "external"; entry.code = "target_managed_elsewhere";
        } else if (file && !file.isFile()) {
          entry.status = "unsupported"; entry.code = "target_not_file";
        } else {
          entry.target = resolveIntegrationTarget({ ...options, codexHome, profile });
        }
      }
    } catch { entry.status = "unavailable"; entry.code = "target_source_unavailable"; }
    entries.push(entry);
  }
  return { entries, issues };
}

function integrationLaunch(target, executable = "codex") {
  return { executable, args: target.kind === "profile" ? ["--profile", target.profile] : [], env: { CODEX_HOME: target.codexHome } };
}

function integrationLaunchCommand(launch, platform = process.platform) {
  const quote = platform === "win32" ? value => `'${value.replaceAll("'", "''")}'` : value => `'${value.replaceAll("'", `'"'"'`)}'`;
  const invocation = [launch.executable, ...launch.args].map(quote).join(" ");
  return platform === "win32" ? `$env:CODEX_HOME = ${quote(launch.env.CODEX_HOME)}; & ${invocation}` : `CODEX_HOME=${quote(launch.env.CODEX_HOME)} ${invocation}`;
}

function validateIntegrationTarget(candidate, owningRuntimeHome) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid integration target");
  if ((candidate.kind !== "base" && candidate.kind !== "profile") || typeof candidate.codexHome !== "string" || typeof candidate.runtimeHome !== "string"
    || (candidate.kind === "profile" ? typeof candidate.profile !== "string" : candidate.profile !== undefined)) throw new Error("Invalid integration target identity");
  const runtimeHome = canonicalConfigurationPath(candidate.runtimeHome);
  const expected = resolveIntegrationTarget({ codexHome: candidate.codexHome, profile: candidate.profile,
    runtimeRoot: candidate.kind === "profile" ? dirname(dirname(runtimeHome)) : runtimeHome });
  for (const key of ["id", "kind", "profile", "codexHome", "configPath", "runtimeHome"]) if (candidate[key] !== expected[key]) throw new Error(`Invalid integration target ${key}; resolve the canonical target again`);
  if (owningRuntimeHome !== undefined && runtimeHome !== canonicalConfigurationPath(owningRuntimeHome)) throw new Error("Integration target does not own this runtime configuration");
  return expected;
}

function integrationConnectorNames(target) {
  const suffix = target?.kind === "profile" ? ` ${target.profile.slice(0, 32)} ${target.id.slice(-8)}` : "";
  return { automatic: `Codex Native2${suffix}`, manual: `Codex Zero Risk${suffix}` };
}

module.exports = { canonicalConfigurationPath, resolveIntegrationTarget, listIntegrationTargets, discoverIntegrationTargets, integrationLaunch, integrationLaunchCommand, validateIntegrationTarget, integrationConnectorNames };
