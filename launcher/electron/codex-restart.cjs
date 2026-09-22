const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

/** Owns one explicit request. Application identity and launch data never come from the renderer. */
class CodexRestartController {
  constructor({ adapter, withIdleBridge, now = Date.now, delay: wait = delay, readRevision, savedEvidence, saveEvidence = () => {} }) {
    Object.assign(this, { adapter, withIdleBridge, now, delay: wait, candidate: null, busy: false, readRevision, saveEvidence });
    this.resetEvidence();
    if (savedEvidence?.version === 1 && typeof savedEvidence.revision === "string" && Number.isFinite(savedEvidence.lastSeen)) {
      this.revision = savedEvidence.revision;
      this.baseline = savedEvidence.baseline;
      this.lastSeen = savedEvidence.lastSeen;
      this.restartedAfter = Number.isFinite(savedEvidence.restartedAfter) ? savedEvidence.restartedAfter : null;
    }
  }
  resetEvidence() { this.baseline = null; this.lastSeen = null; this.restartedAfter = null; this.candidate = null; }
  persistEvidence() { this.saveEvidence({ version: 1, revision: this.revision, baseline: this.baseline ? { identity: this.baseline.identity, location: this.baseline.location } : null, lastSeen: this.lastSeen, restartedAfter: this.restartedAfter }); }
  async reconcileConfiguration() {
    if (!this.readRevision) return;
    const previous = this.reconciliation ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = this.readRevision();
        if (revision === this.revision) return;
        const observedAt = this.now();
        let candidates = await this.adapter.discover();
        if (!candidates.length) candidates = await this.adapter.installed?.() ?? [];
        // Discovery can span a configuration write. Never associate its result
        // with a different configuration, or commit a failed discovery.
        if (this.readRevision() !== revision) continue;
        this.resetEvidence(); this.revision = revision; this.lastSeen = observedAt;
        if (candidates.length === 1) this.baseline = { identity: candidates[0].identity ?? null, location: candidates[0].location };
        this.persistEvidence();
        return;
      }
      throw new Error("Configuration changed during application discovery");
    });
    this.reconciliation = pending;
    try { await pending; }
    finally { if (this.reconciliation === pending) this.reconciliation = null; }
  }
  async restartEvidence() {
    await this.reconcileConfiguration();
    if (this.restartedAfter !== null) return { after: this.restartedAfter };
    if (!this.baseline) return null;
    const candidates = await this.adapter.discover();
    if (candidates.length !== 1) return null;
    const app = candidates[0];
    if (app.identity === this.baseline.identity) { this.lastSeen = this.now(); this.persistEvidence(); return null; }
    if (app.location !== this.baseline.location) return null;
    this.restartedAfter = this.lastSeen;
    this.persistEvidence();
    return { after: this.restartedAfter };
  }
  async availability() {
    if (this.busy) return { status: "manual", reason: "busy" };
    this.candidate = null;
    try {
      await this.reconcileConfiguration();
      let candidates = await this.adapter.discover();
      const mode = candidates.length ? "restart" : "launch";
      if (!candidates.length) candidates = await this.adapter.installed?.() ?? [];
      if (candidates.length !== 1) return { status: "manual", reason: candidates.length ? "ambiguous" : "not-found" };
      const app = candidates[0];
      if (!this.baseline) { this.baseline = app; this.lastSeen = this.now(); }
      if (app.pid === process.pid || app.executable === process.execPath) return { status: "manual", reason: "unsupported" };
      if (mode === "restart" && !app.closeSupported) return { status: "manual", reason: "unsupported", application: app.label, location: app.location };
      const token = randomUUID();
      this.candidate = { app, token, mode, expires: this.now() + 5 * 60_000 };
      return { status: "available", token, mode, application: app.label, location: app.location };
    } catch { return { status: "manual", reason: "discovery-failed" }; }
  }
  async execute(token) {
    const pending = this.candidate;
    if (this.busy) return { status: "manual", reason: "busy" };
    if (!pending || token !== pending.token || this.now() > pending.expires) return { status: "manual", reason: "stale" };
    this.candidate = null;
    this.busy = true;
    try {
      return await this.withIdleBridge(async () => {
        const candidates = await this.adapter.discover();
        if (pending.mode === "launch") {
          const installed = await this.adapter.installed?.() ?? [];
          if (candidates.length || installed.length !== 1 || installed[0].executable !== pending.app.executable || installed[0].source !== pending.app.source) return { status: "manual", reason: "stale" };
          await this.adapter.launch(pending.app);
          this.restartedAfter = this.now();
          this.persistEvidence();
          return { status: "launched", application: pending.app.label };
        }
        if (candidates.length !== 1 || candidates[0].identity !== pending.app.identity || !await this.adapter.sameInstance(pending.app)) return { status: "manual", reason: "stale" };
        await this.adapter.close(pending.app);
        const deadline = this.now() + 30_000;
        while (await this.adapter.sameInstance(pending.app)) {
          if (this.now() >= deadline) return { status: "manual", reason: "timeout" };
          await this.delay(Math.min(250, deadline - this.now()));
        }
        if ((await this.adapter.discover()).length) return { status: "manual", reason: "ambiguous" };
        const exitedAt = this.now();
        await this.adapter.launch(pending.app);
        this.restartedAfter = exitedAt;
        this.persistEvidence();
        // Configuration-load evidence belongs to the existing catalog verification monitor.
        return { status: "launched", application: pending.app.label };
      });
    } catch { return { status: "manual", reason: "restart-failed" }; }
    finally { this.busy = false; }
  }
}
module.exports = { CodexRestartController };
