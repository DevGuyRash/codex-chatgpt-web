const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, nativeImage, webContents } = require("electron");
const QRCode = require("qrcode");
const { DiagnosticError } = require("./logging.cjs");
const { probeBluetoothLe } = require("./bluetooth-le.cjs");
const { placeWindowNearLauncher } = require("./window-placement.cjs");
const { launcherWindowIcon } = require("./desktop-identity.cjs");
const { BrowserAuthenticationPromptStateSchema, BrowserAuthenticationReplySchema } = require("./generated/webauthn-contract.cjs");

const PROMPT_FILE = path.join(__dirname, "webauthn-prompt.html");
const PROMPT_URL = pathToFileURL(PROMPT_FILE).href;
const PIN_REASONS = new Set(["set", "change", "challenge", "unknown"]);
const PIN_ERRORS = new Set(["none", "internal-uv-locked", "wrong-pin", "too-short", "invalid-characters", "same-as-current", "unknown"]);
const BLUETOOTH_STATES = new Set(["on", "off", "permission-denied", "permission-required", "unknown"]);
const HYBRID_STATES = new Set(["phone-connected", "bluetooth-seen", "ready"]);
const MAX_REQUEST_LIFETIME_MS = 10 * 60_000;

class WebAuthnPrompts {
  constructor({ browserSession, parent, ownsWebContents, browserExtensions, logger, publishOperation, isDevelopment = false }) {
    this.browserSession = browserSession;
    this.parent = parent;
    this.isDevelopment = isDevelopment;
    this.ownsWebContents = ownsWebContents;
    this.browserExtensions = browserExtensions;
    this.logger = logger;
    this.publishOperation = publishOperation;
    this.pending = new Map();
    this.window = null;
    this.batchCancelling = false;
    this.replyChannel = "launcher:webauthn-prompt-reply";
    this.currentChannel = "launcher:webauthn-prompt-current";
    this.onPIN = (_event, details, callback) => this.pin(details, callback);
    this.onAccount = (_event, details, callback) => this.account(details, callback);
    this.onQR = (_event, details, callback) => { void this.qr(details, callback); };
    this.onTransport = (_event, details, callback) => this.transport(details, callback);
    this.onBluetooth = (_event, details) => this.bluetooth(details);
    this.onHybridProgress = (_event, details) => this.hybridProgress(details);
    this.onVerification = (_event, details) => this.verification(details);
    this.onFailure = (_event, details) => this.failure(details);
    this.onClosed = (_event, details) => this.closeRequest(details?.requestId, details?.outcome);
    browserSession.on("webauthn-pin-request", this.onPIN);
    browserSession.on("select-webauthn-account", this.onAccount);
    browserSession.on("webauthn-hybrid-qr", this.onQR);
    browserSession.on("webauthn-transport-state", this.onTransport);
    browserSession.on("webauthn-bluetooth-status", this.onBluetooth);
    browserSession.on("webauthn-hybrid-progress", this.onHybridProgress);
    browserSession.on("webauthn-verification-retry", this.onVerification);
    browserSession.on("webauthn-request-failed", this.onFailure);
    browserSession.on("webauthn-request-closed", this.onClosed);
    ipcMain.handle(this.replyChannel, (event, answer) => this.reply(event, answer));
    ipcMain.handle(this.currentChannel, event => this.currentState(event));
  }

  source(details) {
    const frame = details?.frame;
    if (!frame || frame.isDestroyed?.()) return null;
    const contents = webContents.fromFrame(frame);
    if (!contents || contents.isDestroyed() || contents.session !== this.browserSession
      || !this.ownsWebContents(contents)) return null;
    let parsed;
    try { parsed = new URL(frame.url); } catch { return null; }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) return null;
    if (typeof details.relyingPartyId !== "string" || !details.relyingPartyId) return null;
    return { frame, contents, url: frame.url, origin: parsed.origin, relyingPartyId: details.relyingPartyId };
  }

  current() {
    return this.pending.values().next().value || null;
  }

  currentOperation() {
    return this.pending.size ? "passkey authentication" : null;
  }

  extensionProviders() {
    return this.browserExtensions?.catalogStatus().providers
      .filter(provider => provider.installed)
      .map(provider => ({ id: provider.id, name: provider.name })) ?? [];
  }

  ensure(details, kind) {
    const source = this.source(details);
    if (!source) return null;
    const id = details?.requestId;
    if (typeof id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return null;
    let request = this.pending.get(id);
    if (!request) {
      request = { id, ...source, kind, callback: null, qrAction: null, qrDataUrl: null, accounts: null };
      request.operation = this.logger.diagnostics?.begin?.("browser.webauthn", { requestId: id, method: kind }, null);
      this.pending.set(id, request);
      const onDocumentNavigation = (_event, _url, _code, _status, _main, processId, routingId) => {
        if (processId === source.frame.processId && routingId === source.frame.routingId) this.cancel(request, "navigation");
      };
      const onInPageNavigation = () => { if (!this.valid(request)) this.cancel(request, "navigation"); };
      const onDestroyed = () => this.closeRequest(id);
      const expiry = setTimeout(() => this.expire(request), MAX_REQUEST_LIFETIME_MS);
      expiry.unref?.();
      source.contents.on("did-frame-navigate", onDocumentNavigation);
      source.contents.on("did-navigate-in-page", onInPageNavigation);
      source.contents.once("destroyed", onDestroyed);
      request.detach = () => {
        clearTimeout(expiry);
        source.contents.off("did-frame-navigate", onDocumentNavigation);
        source.contents.off("did-navigate-in-page", onInPageNavigation);
        source.contents.off("destroyed", onDestroyed);
      };
      this.logger.info("browser.webauthn_requested", { method: kind, requestId: id, webContentsId: source.contents.id });
    } else if (request.frame !== source.frame || request.contents !== source.contents
      || request.relyingPartyId !== source.relyingPartyId) {
      return null;
    }
    return request;
  }

  pin(details, callback) {
    const request = this.ensure(details, "pin");
    if (!request) { this.logger.warn("browser.webauthn_source_rejected", { method: "pin" }); callback(); return; }
    if (request.methodChosen !== "phone"
      && !(request.kind === "method" && !request.methodChosen)) request.kind = "pin";
    request.callback = callback;
    request.reason = PIN_REASONS.has(details.reason) ? details.reason : "unknown";
    request.error = PIN_ERRORS.has(details.error) ? details.error : "unknown";
    request.minPinLength = Number.isInteger(details.minPinLength) && details.minPinLength >= 1 && details.minPinLength <= 127
      ? details.minPinLength : undefined;
    request.attempts = Number.isInteger(details.attempts) && details.attempts >= 0 && details.attempts <= 100
      ? details.attempts : undefined;
    this.logger.info("browser.webauthn_pin_prompt", {
      requestId: request.id, reason: request.reason, error: request.error, attempts: request.attempts,
    });
    this.show();
  }

  transport(details, callback) {
    const request = this.ensure(details, "method");
    if (!request) { this.logger.warn("browser.webauthn_source_rejected", { method: "transport" }); return; }
    request.securityKeyAvailable = details.securityKeyAvailable === true;
    request.phoneAvailable = details.phoneAvailable === true;
    request.platformAvailable = details.platformAvailable === true;
    if (typeof callback === "function") request.transportAction = callback;
    if (!request.methodChosen && request.kind !== "account" && request.kind !== "verification") {
      const choices = [request.securityKeyAvailable, request.phoneAvailable, request.platformAvailable]
        .filter(Boolean).length + this.extensionProviders().length;
      request.kind = choices > 1 ? "method"
        : request.phoneAvailable ? "qr"
          : request.platformAvailable ? "verification"
            : request.callback ? "pin" : "touch";
    }
    this.logger.info("browser.webauthn_transports", {
      requestId: request.id, securityKey: request.securityKeyAvailable,
      phone: request.phoneAvailable, platform: request.platformAvailable,
    });
    this.show();
  }

  verification(details) {
    const request = this.ensure(details, "verification");
    if (!request) return;
    if (Number.isInteger(details.attempts) && details.attempts >= 0 && details.attempts <= 100) {
      request.verificationAttempts = details.attempts;
    }
    if (request.kind !== "pin" && request.kind !== "account") request.kind = "verification";
    this.show();
  }

  failure(details) {
    const request = this.pending.get(details?.requestId)
      || this.ensure(details, "verification");
    if (!request || !this.valid(request)) return;
    const reason = typeof details.reason === "string" && /^[a-z-]{1,80}$/.test(details.reason)
      ? details.reason : "unknown";
    const messages = {
      timeout: "Passkey sign-in timed out. Start it again from the sign-in page.",
      "pin-temporarily-locked": "The security key PIN is temporarily locked. Follow the key's reset instructions before retrying.",
      "pin-locked": "The security key PIN is locked. Use another passkey or follow the key's recovery instructions.",
      "key-removed": "The security key was unplugged during PIN entry. Reconnect it and try again.",
      "phone-connection-failed": "The phone could not connect. Check Bluetooth on both devices and scan a fresh QR code.",
      "no-passkeys": "No matching passkey was found. Choose another sign-in method.",
    };
    const message = messages[reason] || "Passkey sign-in failed. Choose another method or try again.";
    const problem = new DiagnosticError({ code: `webauthn_${reason.replaceAll("-", "_")}`, message,
      origin: "browser.webauthn", stage: "authentication",
      findings: [{ message: `WebAuthn request ended with ${reason}.` }], actions: ["open-diagnostics"] });
    const reportedProblem = request.operation?.problem(problem) ?? problem.problem;
    request.operation?.end("failed");
    this.logger.warn("browser.webauthn_failed", { requestId: request.id, reason });
    this.publishOperation?.({
      name: "passkey-authentication", status: "failed", message,
      problem: reportedProblem,
    });
    this.closeRequest(request.id);
  }

  expire(request) {
    if (!this.pending.has(request.id)) return;
    const message = "Passkey authentication did not settle. Start a fresh request from the sign-in page.";
    const error = new DiagnosticError({ code: "webauthn_request_timeout", message,
      origin: "browser.webauthn", stage: "authentication", actions: ["open-diagnostics"],
      evidenceMissing: "Chromium did not report a terminal WebAuthn result before the launcher watchdog expired.",
    });
    const problem = request.operation?.problem(error) ?? error.problem;
    request.operation?.end("failed");
    this.publishOperation?.({ name: "passkey-authentication", status: "failed", message, problem });
    this.cancel(request, "timeout");
  }

  account(details, callback) {
    const source = this.source(details);
    if (!source || !Array.isArray(details.accounts)) { this.logger.warn("browser.webauthn_source_rejected", { method: "account" }); callback(); return; }
    const request = this.ensure(details, "account");
    if (!request) { callback(); return; }
    request.kind = "account";
    request.callback = callback;
    request.accounts = details.accounts.filter(item => item && typeof item.credentialId === "string")
      .map(item => ({ credentialId: item.credentialId, name: typeof item.displayName === "string" && item.displayName
        ? item.displayName : typeof item.name === "string" && item.name ? item.name : "Passkey" }));
    if (!request.accounts.length) { this.cancel(request); return; }
    this.logger.info("browser.webauthn_account_prompt", { requestId: request.id, accounts: request.accounts.length });
    this.show();
  }

  async qr(details, callback) {
    const request = this.ensure(details, "qr");
    if (!request) { this.logger.warn("browser.webauthn_source_rejected", { method: "phone" }); callback("cancel"); return; }
    if (typeof details.qr !== "string" || !details.qr.startsWith("FIDO:/") || details.qr.length > 4096) {
      callback("cancel");
      return;
    }
    request.qrAction = callback;
    request.bluetoothStatus = BLUETOOTH_STATES.has(details.bluetoothStatus) ? details.bluetoothStatus : "unknown";
    request.canPowerOnBluetooth = details.canPowerOnBluetooth === true;
    this.logger.info("browser.webauthn_phone_prompt", { requestId: request.id, bluetoothStatus: request.bluetoothStatus });
    try {
      request.qrDataUrl = await QRCode.toDataURL(details.qr, { errorCorrectionLevel: "L", margin: 2, width: 280 });
    } catch {
      this.cancel(request);
      return;
    }
    if (!this.pending.has(request.id) || !this.valid(request)) return;
    if (!["pin", "account", "method", "touch", "verification"].includes(request.kind)) request.kind = "qr";
    this.show();
    void probeBluetoothLe().then(status => {
      if (status !== "disabled" || !this.pending.has(request.id) || !this.valid(request)) return;
      request.hostLeUnavailable = true;
      this.logger.warn("browser.webauthn_le_unavailable", { requestId: request.id });
      this.show();
    }).catch(() => {});
  }

  bluetooth(details) {
    const request = this.pending.get(details?.requestId);
    if (!request) return;
    request.bluetoothStatus = BLUETOOTH_STATES.has(details.status) ? details.status : "unknown";
    this.logger.info("browser.webauthn_bluetooth_status", { requestId: request.id, status: request.bluetoothStatus });
    this.show();
  }

  hybridProgress(details) {
    const request = this.pending.get(details?.requestId);
    if (!request || !HYBRID_STATES.has(details.status)) return;
    request.hybridProgress = details.status;
    this.logger.info("browser.webauthn_phone_progress", { requestId: request.id, status: details.status });
    this.show();
  }

  valid(request) {
    if (!request) return false;
    let origin;
    try { origin = new URL(request.frame.url).origin; } catch { return false; }
    return !request.contents.isDestroyed() && !request.frame.isDestroyed?.()
      && origin === request.origin && webContents.fromFrame(request.frame) === request.contents
      && request.contents.session === this.browserSession && this.ownsWebContents(request.contents);
  }

  payload(request) {
    return {
      id: request.id,
      kind: request.kind,
      origin: request.origin,
      relyingPartyId: request.relyingPartyId,
      reason: request.reason,
      error: request.error,
      minPinLength: request.minPinLength,
      attempts: request.attempts,
      qrDataUrl: request.qrDataUrl,
      bluetoothStatus: request.hostLeUnavailable ? "le-unavailable" : request.bluetoothStatus,
      hybridProgress: request.hybridProgress,
      canPowerOnBluetooth: request.canPowerOnBluetooth,
      securityKeyAvailable: request.securityKeyAvailable,
      phoneAvailable: request.phoneAvailable,
      platformAvailable: request.platformAvailable,
      extensionProviders: this.extensionProviders(),
      verificationAttempts: request.verificationAttempts,
      accounts: request.accounts,
    };
  }

  show() {
    const request = this.current();
    if (!request || !this.valid(request)) {
      if (request) this.cancel(request);
      return;
    }
    if (!this.window || this.window.isDestroyed()) {
      this.parent.show();
      this.window = new BrowserWindow({
        show: false, alwaysOnTop: true, skipTaskbar: false,
        width: 420, height: 500, minWidth: 360, minHeight: 390,
        title: "Passkey authentication", icon: launcherWindowIcon(nativeImage, { packaged: app?.isPackaged === true, isDevelopment: this.isDevelopment }),
        autoHideMenuBar: true, backgroundColor: "#181818",
        webPreferences: {
          preload: path.join(__dirname, "generated", "webauthn-preload.cjs"),
          contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
      });
      const window = this.window;
      placeWindowNearLauncher(window, this.parent);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => { if (url !== PROMPT_URL) event.preventDefault(); });
      window.webContents.on("did-finish-load", () => {
        if (this.window !== window) return;
        this.sendCurrent();
        window.show();
        window.moveTop();
        window.focus();
      });
      window.on("closed", () => {
        if (this.window !== window) return;
        this.window = null;
        this.cancelAll();
      });
      void window.loadFile(PROMPT_FILE).catch(() => {
        if (this.window === window) window.close();
      });
    } else {
      this.window.show();
      if (!this.window.isFocused()) {
        this.window.moveTop();
        this.window.focus();
      }
      this.sendCurrent();
    }
  }

  sendCurrent() {
    const request = this.current();
    if (request && this.window && !this.window.isDestroyed() && !this.window.webContents.isLoading()) {
      const state = this.currentState({ sender: this.window.webContents });
      if (state) this.window.webContents.send("launcher:webauthn-prompt-state", state);
    }
  }

  currentState(event) {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents) return null;
    const request = this.current();
    if (!request) return null;
    if (!this.valid(request)) { this.cancel(request, "stale-document"); return null; }
    const state = BrowserAuthenticationPromptStateSchema.safeParse(this.payload(request));
    if (!state.success) { this.cancel(request, "invalid-state"); return null; }
    return state.data;
  }

  reply(event, answer) {
    if (!this.window || event.sender !== this.window.webContents) return false;
    const parsed = BrowserAuthenticationReplySchema.safeParse(answer);
    if (!parsed.success) return false;
    const input = parsed.data;
    const request = this.current();
    if (!request || input.id !== request.id || !this.valid(request)) return false;
    if (input.action === "cancel") { this.cancel(request); return true; }
    if (input.action === "submit-pin" && request.kind === "pin" && request.callback
      && input.pin.length >= (request.minPinLength || 1)) {
      const callback = request.callback;
      request.callback = null;
      request.kind = "touch";
      request.methodChosen = "security-key";
      this.show();
      try { callback(input.pin); }
      catch (error) {
        this.logger.warn("browser.webauthn_pin_callback_failed", { requestId: request.id, errorType: error?.name || "Error" });
        this.cancel(request);
        return false;
      }
      return true;
    }
    if (input.action === "select-account" && request.kind === "account" && request.callback
      && request.accounts.some(item => item.credentialId === input.credentialId)) {
      const callback = request.callback;
      request.callback = null;
      request.kind = "verification";
      request.accounts = null;
      this.show();
      try { callback(input.credentialId); }
      catch (error) {
        this.logger.warn("browser.webauthn_account_callback_failed", { requestId: request.id, errorType: error?.name || "Error" });
        this.cancel(request);
        return false;
      }
      return true;
    }
    if (input.action === "use-security-key" && ["qr", "method"].includes(request.kind)
      && request.securityKeyAvailable) {
      request.methodChosen = "security-key";
      request.kind = request.callback ? "pin" : "touch";
      this.show();
      return true;
    }
    if (input.action === "use-phone" && ["method", "touch", "verification", "pin"].includes(request.kind)
      && request.phoneAvailable) {
      request.methodChosen = "phone";
      request.kind = "qr";
      this.show();
      return true;
    }
    if (input.action === "use-device" && request.kind === "method" && request.platformAvailable) {
      request.methodChosen = "device";
      request.kind = "verification";
      this.show();
      return true;
    }
    if (input.action === "choose-method" && ["pin", "touch", "qr", "verification"].includes(request.kind)) {
      request.methodChosen = null;
      request.kind = "method";
      this.show();
      return true;
    }
    if (input.action === "use-extension"
      && this.extensionProviders().some(provider => provider.id === input.extensionId)) {
      this.cancel(request, "provider-switch");
      setImmediate(() => {
        void this.browserExtensions.open(input.extensionId).catch(error => {
          const message = "The password manager could not open. Try its browser toolbar button or another passkey method.";
          this.logger.warn("browser.extension_open_failed", {
            id: input.extensionId, errorType: error?.name || "Error",
          });
          this.publishOperation?.({ name: "passkey-provider", status: "failed", message });
        });
      });
      return true;
    }
    if (request.kind === "qr" && request.qrAction
      && ["power-on-bluetooth", "request-bluetooth-permission"].includes(input.action)) {
      request.qrAction(input.action);
      return true;
    }
    return false;
  }

  cancel(request, reason = "user") {
    if (!this.pending.has(request.id)) return;
    this.pending.delete(request.id);
    request.detach?.();
    const callbacks = request.methodChosen === "phone"
      ? [[request.qrAction, "cancel"], [request.callback, undefined], [request.transportAction, "cancel"]]
      : [[request.callback, undefined], [request.qrAction, "cancel"], [request.transportAction, "cancel"]];
    request.callback = null;
    request.qrAction = null;
    request.transportAction = null;
    request.qrDataUrl = null;
    let callbackFailed = false;
    const invoked = new Set();
    for (const [callback, action] of callbacks) {
      if (typeof callback !== "function" || invoked.has(callback)) continue;
      invoked.add(callback);
      try { callback(action); }
      catch (error) {
        callbackFailed = true;
        request.operation?.problem(new DiagnosticError({
          code: "webauthn_cancel_callback_failed", message: "The native passkey cancellation callback failed",
          origin: "browser.webauthn", stage: "authentication", actions: ["open-diagnostics"],
          evidenceMissing: "The native request's terminal state could not be confirmed.",
        }));
        this.logger.warn("browser.webauthn_cancel_callback_failed", {
          requestId: request.id, errorType: error?.name || "Error",
        });
      }
    }
    this.logger.info("browser.webauthn_cancelled", { method: request.kind, requestId: request.id, reason });
    request.operation?.end(callbackFailed ? "unknown" : "cancelled");
    if (!this.batchCancelling) this.next();
  }

  cancelAll(reason = "user") {
    this.batchCancelling = true;
    try { for (const request of [...this.pending.values()]) this.cancel(request, reason); }
    finally { this.batchCancelling = false; this.next(); }
  }

  closeRequest(id, outcome) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.detach?.();
    request.callback = null;
    request.qrAction = null;
    request.transportAction = null;
    request.qrDataUrl = null;
    this.logger.info("browser.webauthn_settled", { method: request.kind, requestId: request.id });
    request.operation?.end(outcome === "succeeded" ? "succeeded" : "unknown");
    if (!this.batchCancelling) this.next();
  }

  next() {
    if (this.pending.size) { this.show(); return; }
    const window = this.window;
    this.window = null;
    if (window && !window.isDestroyed()) window.close();
  }

  destroy() {
    this.browserSession.off("webauthn-pin-request", this.onPIN);
    this.browserSession.off("select-webauthn-account", this.onAccount);
    this.browserSession.off("webauthn-hybrid-qr", this.onQR);
    this.browserSession.off("webauthn-transport-state", this.onTransport);
    this.browserSession.off("webauthn-bluetooth-status", this.onBluetooth);
    this.browserSession.off("webauthn-hybrid-progress", this.onHybridProgress);
    this.browserSession.off("webauthn-verification-retry", this.onVerification);
    this.browserSession.off("webauthn-request-failed", this.onFailure);
    this.browserSession.off("webauthn-request-closed", this.onClosed);
    ipcMain.removeHandler(this.replyChannel);
    ipcMain.removeHandler(this.currentChannel);
    this.cancelAll("shutdown");
  }
}

module.exports = { WebAuthnPrompts };
