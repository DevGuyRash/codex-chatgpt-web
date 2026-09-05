const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

/** Owns one explicit request. Application identity and launch data never come from the renderer. */
class CodexRestartController {
  constructor({ adapter, withIdleBridge, now = Date.now, delay: wait = delay }) {
    Object.assign(this, { adapter, withIdleBridge, now, delay: wait, candidate: null, busy: false });
    this.resetEvidence();
  }
  resetEvidence() { this.baseline = null; this.lastSeen = null; this.restartedAfter = null; this.candidate = null; }
  async restartEvidence() {
    if (this.restartedAfter !== null) return { after: this.restartedAfter };
    if (!this.baseline) return null;
    const candidates = await this.adapter.discover();
    if (candidates.length !== 1) return null;
    const app = candidates[0];
    if (app.identity === this.baseline.identity) { this.lastSeen = this.now(); return null; }
    if (app.location !== this.baseline.location) return null;
    this.restartedAfter = this.lastSeen;
    return { after: this.restartedAfter };
  }
  async availability() {
    if (this.busy) return { status: "manual", reason: "busy" };
    this.candidate = null;
    try {
      const candidates = await this.adapter.discover();
      if (candidates.length !== 1) return { status: "manual", reason: candidates.length ? "ambiguous" : "not-found" };
      const app = candidates[0];
      if (!this.baseline) { this.baseline = app; this.lastSeen = this.now(); }
      if (app.pid === process.pid || app.executable === process.execPath) return { status: "manual", reason: "unsupported" };
      if (!app.closeSupported) return { status: "manual", reason: "unsupported", application: app.label, location: app.location };
      const token = randomUUID();
      this.candidate = { app, token, expires: this.now() + 5 * 60_000 };
      return { status: "available", token, application: app.label, location: app.location };
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
        // Configuration-load evidence belongs to the existing catalog verification monitor.
        return { status: "launched", application: pending.app.label };
      });
    } catch { return { status: "manual", reason: "restart-failed" }; }
    finally { this.busy = false; }
  }
}
module.exports = { CodexRestartController };
