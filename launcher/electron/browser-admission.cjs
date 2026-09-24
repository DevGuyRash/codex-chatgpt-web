/** One launcher owns browser admission across every helper using its authenticated control channel. */
class BrowserAdmission {
  constructor({ capacity = 5, pageCapacity = 5, activeCount, ownsActivePage = () => true, now = Date.now, ownerAlive = () => true, report = () => {}, maxQueued = 128, staleMs = 30_000 }) {
    Object.assign(this, { capacity, pageCapacity, activeCount, ownsActivePage, now, ownerAlive, report, maxQueued, staleMs });
    this.entries = new Map();
    this.starting = 0;
  }
  emit(name, data, entry = this.entries.get(data.traceId)) {
    this.report(name, data, entry?.diagnosticContext);
  }
  reportOwned(traceId, helperPid, name, data) {
    const entry = this.entries.get(traceId);
    if (!entry || entry.helperPid !== helperPid) return false;
    this.emit(name, data, entry);
    return true;
  }
  request({ traceId, helperPid, identity, diagnosticContext, start, abandon }) {
    this.sweep();
    let entry = this.entries.get(traceId);
    if (entry) {
      if (entry.helperPid !== helperPid || entry.identity !== identity || entry.diagnosticContext?.traceId !== diagnosticContext?.traceId) throw Object.assign(new Error("Browser admission ownership or metadata changed"), { code: "browser_admission_owner_mismatch" });
      if (entry.cancelled) throw Object.assign(new Error("Browser admission was cancelled"), { code: "turn_cancelled" });
      entry.touched = this.now();
    } else {
      if (this.entries.size >= this.maxQueued) throw Object.assign(new Error("Browser admission queue is full"), { code: "browser_queue_full" });
      entry = { traceId, helperPid, identity, diagnosticContext: diagnosticContext ? { ...diagnosticContext } : undefined, start, abandon, state: "queued", queuedAt: this.now(), touched: this.now() };
      this.entries.set(traceId, entry);
      this.emit("browser.queued", { traceId, helperPid, capacity: this.capacity });
    }
    this.drain();
    if (entry.state === "failed") { this.entries.delete(traceId); throw entry.error; }
    if (entry.state === "ready") return { queued: false, ...entry.result };
    return { queued: true, position: [...this.entries.values()].filter(value => value.state === "queued").indexOf(entry) + 1, waitingMs: this.now() - entry.queuedAt };
  }
  cancel(traceId, helperPid) {
    const entry = this.entries.get(traceId);
    if (!entry) return false;
    if (entry.helperPid !== helperPid) throw Object.assign(new Error("Browser admission belongs to another helper"), { code: "browser_admission_owner_mismatch" });
    entry.cancelled = true;
    entry.touched = this.now();
    if (entry.state === "queued") entry.state = "cancelled";
    this.emit("browser.queue_cancelled", { traceId, waitingMs: this.now() - entry.queuedAt });
    this.drain();
    return !entry.result;
  }
  owned(traceId, helperPid) {
    const entry = this.entries.get(traceId);
    if (!entry || entry.helperPid !== helperPid) throw Object.assign(new Error("Browser admission belongs to another helper or has ended"), { code: "browser_admission_owner_mismatch" });
    if (entry.cancelled) throw Object.assign(new Error("Browser admission was cancelled"), { code: "turn_cancelled" });
    return entry;
  }
  park(traceId, helperPid, revision) {
    const entry = this.owned(traceId, helperPid);
    if (!Number.isSafeInteger(revision) || revision <= 0 || !entry.result) throw new Error("Invalid browser generation boundary");
    if (revision <= (entry.parkRevision ?? 0)) return;
    if (entry.state !== "ready") throw new Error("Browser generation is already parked");
    entry.parkRevision = revision;
    entry.state = "parked";
    this.emit("browser.generation_parked", { traceId, revision });
    this.drain();
  }
  resume(traceId, helperPid, revision) {
    const entry = this.owned(traceId, helperPid);
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision !== entry.parkRevision) throw new Error("Invalid browser generation resume boundary");
    if (entry.state === "parked") {
      entry.state = "resume-queued";
      entry.queuedAt = this.now();
    }
    entry.touched = this.now();
    this.drain();
    return { queued: entry.state !== "ready", position: this.waiting().indexOf(entry) + 1 };
  }
  waiting() {
    return [...this.entries.values()].filter(entry => !entry.cancelled && ["queued", "resume-queued"].includes(entry.state)).sort((a, b) => a.queuedAt - b.queuedAt);
  }
  release(traceId, helperPid) {
    const entry = this.entries.get(traceId);
    if (entry?.helperPid === helperPid) { this.entries.delete(traceId); this.emit("browser.admission_released", { traceId, helperPid, state: entry.state }, entry); }
    this.drain();
  }
  sweep() {
    for (const entry of this.entries.values()) {
      if (entry.result && (!this.ownsActivePage(entry.traceId, entry.helperPid) || !this.ownerAlive(entry.helperPid))) {
        this.entries.delete(entry.traceId);
        this.emit("browser.acquired_owner_reaped", { traceId: entry.traceId, helperPid: entry.helperPid }, entry);
        continue;
      }
      if (["queued", "cancelled", "failed"].includes(entry.state) && (this.now() - entry.touched >= this.staleMs || !this.ownerAlive(entry.helperPid))) {
        this.entries.delete(entry.traceId);
        this.emit("browser.queue_expired", { traceId: entry.traceId, waitingMs: this.now() - entry.queuedAt }, entry);
      }
    }
  }
  drain() {
    this.sweep();
    for (const entry of this.waiting()) {
      const parked = [...this.entries.values()].filter(value => ["parked", "resume-queued"].includes(value.state) && this.ownsActivePage(value.traceId, value.helperPid)).length;
      if (this.activeCount() - parked + this.starting >= this.capacity) break;
      if (entry.state === "resume-queued") {
        entry.state = "ready";
        this.emit("browser.generation_resumed", { traceId: entry.traceId, revision: entry.parkRevision, waitingMs: this.now() - entry.queuedAt });
        continue;
      }
      if (this.activeCount() + this.starting >= this.pageCapacity) {
        // A retained parent can be waiting for this very child. Returning a local resource error
        // lets that tool call settle and its ancestors resume; indefinite queueing can form a cycle.
        entry.state = "failed";
        entry.error = Object.assign(new Error("The retained browser-page limit was reached. Finish or reduce nested browser work before starting another page."), { code: "browser_page_capacity_exhausted" });
        this.emit("browser.acquisition_failed", { traceId: entry.traceId, code: entry.error.code });
        continue;
      }
      entry.state = "starting";
      this.starting++;
      this.emit("browser.acquisition_started", { traceId: entry.traceId, waitingMs: this.now() - entry.queuedAt });
      Promise.resolve().then(entry.start).then(async result => {
        if (entry.cancelled) { await entry.abandon(result); entry.state = "cancelled"; return; }
        entry.result = result;
        entry.state = "ready";
        this.emit("browser.acquisition_completed", { traceId: entry.traceId }, entry);
      }).catch(error => { entry.state = "failed"; entry.error = error; this.emit("browser.acquisition_failed", { traceId: entry.traceId, code: error?.code ?? "browser_acquisition_failed" }, entry); })
        .finally(() => { this.starting--; this.drain(); });
    }
  }
}
module.exports = { BrowserAdmission };
