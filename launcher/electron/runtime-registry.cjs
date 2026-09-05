const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { canonicalConfigurationPath, discoverIntegrationTargets, resolveIntegrationTarget, validateIntegrationTarget } = require("./integration-target.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

function portAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", error => error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(false) : reject(error));
    server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : resolve(true)));
  });
}

/** Persistent identities and endpoint reservations. Each target has its own launcher/runtime process. */
class RuntimeRegistry {
  constructor({ runtimeRoot }) {
    this.runtimeRoot = canonicalConfigurationPath(runtimeRoot);
    this.path = path.join(this.runtimeRoot, "targets", "registry.json");
  }

  read() {
    if (!fs.existsSync(this.path)) return { version: 1, targets: [] };
    let value;
    try { value = JSON.parse(fs.readFileSync(this.path, "utf8")); } catch { throw new Error("Runtime registry is unreadable; preserve it and review the target records before continuing"); }
    if (value?.version !== 1 || !Array.isArray(value.targets) || value.targets.length > 128) throw new Error("Runtime registry is invalid");
    const ids = new Set();
    const ports = new Set();
    for (const entry of value.targets) {
      const target = validateIntegrationTarget(entry.target);
      if (target.kind !== "profile" || path.dirname(path.dirname(target.runtimeHome)) !== this.runtimeRoot
        || !Number.isSafeInteger(entry.port) || entry.port < 1024 || entry.port > 65535 || ids.has(target.id) || ports.has(entry.port)) throw new Error("Runtime registry contains conflicting target ownership or endpoints");
      ids.add(target.id);
      ports.add(entry.port);
    }
    return value;
  }

  list(codexHome) {
    return this.discover(codexHome).entries.flatMap(entry => entry.target ? [entry.target] : []);
  }

  discover(codexHome) {
    const result = discoverIntegrationTargets({ codexHome, runtimeRoot: this.runtimeRoot });
    const home = result.entries[0]?.codexHome;
    const known = new Map(result.entries.map(entry => [entry.id, entry]));
    try {
      if (fs.existsSync(this.path)) {
        const state = JSON.parse(fs.readFileSync(this.path, "utf8"));
        if (state?.version !== 1 || !Array.isArray(state.targets) || state.targets.length > 128) throw new Error("Invalid registry");
        const ids = new Set();
        const ports = new Set();
        for (const entry of state.targets) {
          try {
            const target = validateIntegrationTarget(entry.target);
            if (target.kind !== "profile" || path.dirname(path.dirname(target.runtimeHome)) !== this.runtimeRoot) throw new Error("Invalid owner");
            if (!Number.isSafeInteger(entry.port) || entry.port < 1024 || entry.port > 65535 || ids.has(target.id) || ports.has(entry.port)) throw new Error("Conflicting registry endpoint");
            ids.add(target.id); ports.add(entry.port);
            if (target.codexHome === home && !known.has(target.id)) known.set(target.id, { ...target, status: "available", target });
          } catch { result.issues.push({ code: "target_registry_entry_unavailable", path: this.path }); }
        }
      }
    } catch { result.issues.push({ code: "target_registry_unavailable", path: this.path }); }
    return { entries: [...known.values()].sort((a, b) => a.kind === "base" ? -1 : b.kind === "base" ? 1 : a.profile.localeCompare(b.profile)), issues: result.issues };
  }

  assertBaseOwner(target) {
    if (target.kind !== "base") return;
    const configPath = path.join(this.runtimeRoot, "config.json");
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
      if (config.integrationTarget && validateIntegrationTarget(config.integrationTarget, this.runtimeRoot).id !== target.id) throw new Error("This base runtime already belongs to another Codex home; open that base target or use a named profile");
    }
    for (const name of ["integration-journal.json", "integration-journal.recovery.json"]) {
      const journalPath = path.join(this.runtimeRoot, "codex", name);
      if (!fs.existsSync(journalPath)) continue;
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      if (typeof journal.configPath !== "string" || canonicalConfigurationPath(journal.configPath) !== target.configPath) throw new Error("The legacy base restoration journal belongs to another Codex home; select its owner instead");
    }
  }

  async ensure(target) {
    validateIntegrationTarget(target);
    if (target.kind !== "profile" || path.dirname(path.dirname(target.runtimeHome)) !== this.runtimeRoot) throw new Error("Runtime registry can reserve only its own named-profile runtimes");
    const lock = `${this.path}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    let fd;
    const deadline = Date.now() + 2_000;
    while (fd === undefined) {
      try { fd = fs.openSync(lock, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error(`Runtime registry is busy: ${lock}. If its owner crashed, inspect the registry before removing the stale lock.`);
        await delay(40);
      }
    }
    try {
      fs.writeFileSync(fd, identity);
      const state = this.read();
      const found = state.targets.find(entry => entry.target.id === target.id);
      if (found) return found;
      const reserved = new Set([17841, ...state.targets.map(entry => entry.port)]);
      const baseConfigPath = path.join(this.runtimeRoot, "config.json");
      if (fs.existsSync(baseConfigPath)) {
        const base = JSON.parse(fs.readFileSync(baseConfigPath, "utf8").replace(/^\uFEFF/, ""));
        if (!Number.isSafeInteger(base.port) || base.port < 1024 || base.port > 65535) throw new Error("Base runtime port is invalid; resolve it before reserving another endpoint");
        reserved.add(base.port);
      }
      let preferred;
      const configPath = path.join(target.runtimeHome, "config.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        validateIntegrationTarget(config.integrationTarget, target.runtimeHome);
        preferred = config.port;
        if (!Number.isSafeInteger(preferred) || preferred < 1024 || preferred > 65535 || reserved.has(preferred)) throw new Error("The existing profile endpoint conflicts with the runtime registry; review its port before registration");
      }
      let port = preferred ?? 18000 + parseInt(target.id.slice(-4), 16) % 40000;
      if (preferred === undefined) {
        let remaining = 1000;
        while (reserved.has(port) || !await portAvailable(port)) {
          if (--remaining <= 0) throw new Error("No independent endpoint could be reserved; choose an available runtime port before setup");
          port = port === 65535 ? 18000 : port + 1;
        }
      }
      const entry = { target, port };
      state.targets.push(entry);
      writePrivateFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
      return entry;
    } finally {
      fs.closeSync(fd);
      if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === identity) fs.unlinkSync(lock);
    }
  }
}

module.exports = { RuntimeRegistry };
