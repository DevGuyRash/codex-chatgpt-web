function resolutionArguments(resolutions = []) {
  if (!Array.isArray(resolutions) || resolutions.length > 128 || !resolutions.every(item => item && Object.keys(item).length === 1 && typeof item.occurrenceId === "string" && /^[a-f0-9]{64}$/.test(item.occurrenceId))) throw new Error("Configuration choices must reference occurrences in the current preview");
  return resolutions.flatMap(item => ["--resolve", item.occurrenceId]);
}

function parseConfigurationPreview(output, protocol) {
  let preview;
  try { preview = JSON.parse(output); } catch { throw new Error("The runtime returned an unreadable configuration preview"); }
  const scalar = value => value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  const text = value => typeof value === "string" && value.length <= 4096;
  if (!preview || ![1, 2].includes(preview.version) || !["native", "compatibility-v1"].includes(preview.protocol)
    || (protocol !== undefined && preview.protocol !== protocol)
    || !["ready", "blocked"].includes(preview.status)
    || typeof preview.approvalId !== "string"
    || (preview.status === "ready" && !/^[a-f0-9]{64}$/.test(preview.approvalId))
    || !Array.isArray(preview.changes) || preview.changes.length > 512
    || !preview.changes.every(change => change && text(change.path) && scalar(change.current) && scalar(change.proposed)
      && (change.currentState === undefined || ["active", "commented_out", "missing"].includes(change.currentState))
      && (change.currentLines === undefined || (Array.isArray(change.currentLines) && change.currentLines.length <= 512 && change.currentLines.every(line => Number.isSafeInteger(line) && line > 0))))
    || !Array.isArray(preview.conflicts) || preview.conflicts.length > 512
    || !preview.conflicts.every(conflict => conflict && text(conflict.path) && text(conflict.message)
      && ["missing", "commented_out", "value_changed", "hook_changed", "invalid_config", "ownership_conflict"].includes(conflict.category)
      && (conflict.current === undefined || scalar(conflict.current)) && (conflict.expected === undefined || scalar(conflict.expected)))
    || (preview.effects !== undefined && (!Array.isArray(preview.effects) || preview.effects.length > 32 || !preview.effects.every(text)))
    || (preview.textChanges !== undefined && (!Array.isArray(preview.textChanges) || preview.textChanges.length > 16 || !preview.textChanges.every(change => change && text(change.path) && Number.isSafeInteger(change.startLine) && change.startLine > 0 && typeof change.before === "string" && typeof change.after === "string")))
    || typeof preview.codexRestartRequired !== "boolean" || typeof preview.launcherRestartRequired !== "boolean") {
    throw new Error("The runtime configuration preview is unsupported or malformed; refresh the local runtime build");
  }
  if (preview.version === 2 && (!preview.target || !text(preview.target.id) || !["base", "profile"].includes(preview.target.kind)
    || ![preview.target.codexHome, preview.target.configPath, preview.target.runtimeHome].every(text)
    || (preview.target.kind === "profile" && (typeof preview.target.profile !== "string" || !/^[A-Za-z0-9_-]+$/.test(preview.target.profile)))
    || !Array.isArray(preview.groups) || preview.groups.length > 7
    || !preview.groups.every(group => group && ["connection", "subagents", "interrupt", "catalog", "runtime", "integrations", "other"].includes(group.id)
      && Array.isArray(group.settings) && group.settings.length <= 512 && group.settings.every(setting => setting && text(setting.path)
        && scalar(setting.current) && scalar(setting.proposed) && ["active", "commented_out", "missing", "ambiguous"].includes(setting.state)
        && typeof setting.inherited === "boolean" && typeof setting.resolutionRequired === "boolean"
        && (setting.changeKind === undefined || ["added", "removed", "changed", "unchanged", "unresolved"].includes(setting.changeKind))
        && (setting.baseline === undefined || scalar(setting.baseline))
        && Array.isArray(setting.findings) && setting.findings.length <= 512 && setting.findings.every(finding => finding && text(finding.message) && text(finding.path))
        && Array.isArray(setting.occurrences) && setting.occurrences.length <= 512 && setting.occurrences.every(item => item && /^[a-f0-9]{64}$/.test(item.id)
          && text(item.file) && Number.isSafeInteger(item.line) && item.line > 0 && Number.isSafeInteger(item.endLine) && item.endLine >= item.line
          && ["active", "commented_out"].includes(item.state) && ["base", "profile"].includes(item.layer)
          && ["tracked", "unclaimed"].includes(item.ownership) && scalar(item.value)))))) {
    throw new Error("The runtime configuration review evidence is unsupported or malformed");
  }
  if (preview.resolutions !== undefined) resolutionArguments(preview.resolutions);
  if (preview.additionalTargets !== undefined) {
    if (!Array.isArray(preview.additionalTargets) || preview.additionalTargets.length > 1) throw new Error("Unsupported additional migration targets");
    for (const related of preview.additionalTargets) {
      if (!related || Object.keys(related).some(key => !["target", "groups"].includes(key)) || related.target?.kind !== "base") throw new Error("Unsupported migration target evidence");
      parseConfigurationPreview(JSON.stringify({ ...preview, target: related.target, groups: related.groups, additionalTargets: undefined }), protocol);
    }
  }
  return preview;
}

/** One expiring UI decision. It carries no file or process mutation authority of its own. */
class ConfigurationReview {
  constructor({ publish, timeoutMs = 15 * 60_000 }) {
    this.publish = publish;
    this.timeoutMs = timeoutMs;
    this.pending = null;
  }
  snapshot() { return this.pending?.preview ?? null; }
  request(preview, refresh) {
    if (this.pending) return Promise.reject(new Error("Another configuration preview is awaiting a decision"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel("Configuration preview expired; start setup again for a fresh preview"), this.timeoutMs);
      timer.unref?.();
      this.pending = { preview, refresh, resolve, reject, timer };
      this.publish(preview);
    });
  }
  decide(approvalId, approved) {
    const protocolChange = approved === "native" || approved === "compatibility-v1";
    const resolutionChange = approved && typeof approved === "object" && Object.keys(approved).length === 1 && Array.isArray(approved.resolutions);
    if (resolutionChange) resolutionArguments(approved.resolutions);
    if (!this.pending || this.pending.preview.approvalId !== approvalId || (!protocolChange && !resolutionChange && typeof approved !== "boolean")) {
      throw new Error("This configuration preview is no longer current");
    }
    if (approved !== false && this.pending.preview.refreshing) throw new Error("Configuration preview is refreshing; wait for the current comparison");
    if (approved === true && this.pending.preview.status !== "ready") throw new Error("Resolve configuration conflicts before approval");
    const pending = this.pending;
    if (protocolChange || resolutionChange) {
      if (typeof pending.refresh !== "function") throw new Error("This configuration review cannot refresh its protocol");
      pending.preview = { ...pending.preview, ...(protocolChange ? { protocol: approved } : {}), approvalId: "", refreshing: true };
      this.publish(pending.preview);
      return Promise.resolve().then(() => this.pending === pending ? pending.refresh(approved) : undefined).then(next => {
        if (this.pending !== pending) return;
        const refreshed = parseConfigurationPreview(JSON.stringify(next), pending.preview.protocol);
        if (pending.preview.target && (!refreshed.target || ["id", "kind", "profile", "codexHome", "configPath", "runtimeHome"].some(key => pending.preview.target[key] !== refreshed.target[key]))) throw new Error("The selected integration target changed; cancel and open its own configuration review");
        pending.preview = refreshed;
        this.publish(pending.preview);
      }).catch(error => {
        if (this.pending !== pending) return;
        pending.preview = { ...pending.preview, status: "blocked", approvalId: "", refreshing: false,
          changes: [], textChanges: [], additionalTargets: undefined, conflicts: [{ path: "preview", category: "ownership_conflict", message: error instanceof Error ? error.message : "The configuration preview could not be refreshed" }] };
        if (pending.preview.version === 2) pending.preview.groups = [{ id: "other", settings: [{ path: "preview", current: null, proposed: null, state: "missing", inherited: false, resolutionRequired: false, occurrences: [], findings: pending.preview.conflicts }] }];
        this.publish(pending.preview);
      });
    }
    this.pending = null;
    clearTimeout(pending.timer);
    this.publish(null);
    if (approved) pending.resolve(approvalId);
    else pending.reject(new Error("Setup preview cancelled; no setup changes were applied"));
  }
  cancel(message = "Setup preview cancelled") {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    this.publish(null);
    pending.reject(new Error(message));
  }
}

module.exports = { ConfigurationReview, parseConfigurationPreview, resolutionArguments };
