const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { BrowserWindow } = require("electron");
const { ElectronChromeExtensions } = require("electron-chrome-extensions");
const { downloadExtension } = require("electron-chrome-web-store");
const { BROWSER_EXTENSION_CATALOG, REVIEWED_EXTENSION_PERMISSIONS } = require("./browser-extension-catalog.cjs");
const { createNativeHostLifecycle } = require("./native-host-lifecycle.cjs");
const { placeWindowNearLauncher } = require("./window-placement.cjs");

const ONE_PASSWORD_EXTENSION_ID = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
const CATALOG_BY_ID = new Map(BROWSER_EXTENSION_CATALOG.map(provider => [provider.id, provider]));
const UPDATE_URL = "https://update.googleapis.com/service/update2/json";
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 60_000;

function assertReviewedManifest(extensionPath, provider) {
  const manifest = JSON.parse(readFileSync(path.join(extensionPath, "manifest.json"), "utf8"));
  if (manifest.manifest_version !== 3 || !Array.isArray(manifest.permissions)
    || (manifest.optional_permissions != null && !Array.isArray(manifest.optional_permissions))) {
    throw new Error(`${provider.name} changed its extension manifest; review it before loading`);
  }
  const permissions = [...manifest.permissions, ...(manifest.optional_permissions || [])];
  if (permissions.some(permission => !REVIEWED_EXTENSION_PERMISSIONS.has(permission))) {
    throw new Error(`${provider.name} requests a new permission; review its native support before loading`);
  }
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){1,4}$/.test(manifest.version)) {
    throw new Error(`${provider.name} has an invalid Chrome Web Store version`);
  }
  return manifest;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

class BrowserExtensions {
  constructor({ browserSession, userData, parent, logger }) {
    this.browserSession = browserSession;
    this.parent = parent;
    this.extensionsPath = path.join(userData, "browser-extensions");
    this.logger = logger;
    this.pages = new Set();
    this.api = new ElectronChromeExtensions({
      license: "GPL-3.0", session: browserSession,
      createTab: details => this.createTab(details),
      createWindow: details => this.createWindow(details),
      removeWindow: window => { if (this.pages.has(window) && !window.isDestroyed()) window.close(); },
    });
    this.nativeHostLifecycle = createNativeHostLifecycle({ logger, providerIds: CATALOG_BY_ID });
    this.api.on("native-messaging-lifecycle", this.nativeHostLifecycle.observe);
    const preload = require.resolve("electron-chrome-extensions/preload");
    const registered = browserSession.getPreloadScripts();
    if (!registered.some(script => script.type === "frame" && script.filePath === preload)) {
      browserSession.registerPreloadScript({ id: "codex-web-gpt-crx-frame", type: "frame", filePath: preload });
    }
    if (!registered.some(script => script.type === "service-worker" && script.filePath === preload)) {
      browserSession.registerPreloadScript({ id: "codex-web-gpt-crx-worker", type: "service-worker", filePath: preload });
    }
    this.logger.info("browser.extension_preloads", {
      scripts: browserSession.getPreloadScripts().map(script => ({ id: script.id, type: script.type })),
    });
    this.loaded = new Map();
    this.installing = new Map();
    this.availableUpdates = new Map();
    this.checkingUpdates = null;
    this.lastCheckedAt = null;
    this.autoCheckTimer = null;
  }

  register(contents, window) {
    if (!contents || contents.isDestroyed()) throw new Error("Browser extension tab is unavailable");
    if (contents.session !== this.browserSession) throw new Error("Browser extension tab belongs to another session");
    this.api.addTab(contents, window);
  }

  select(contents) {
    if (contents && !contents.isDestroyed()) this.api.selectTab(contents);
  }

  unregister(contents) {
    if (contents && !contents.isDestroyed()) this.api.removeTab(contents);
  }

  ownsWebContents(contents) {
    return [...this.pages].some(window => !window.isDestroyed() && window.webContents === contents);
  }

  extensionPageUrl(value) {
    if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid extension page URL");
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "chrome-extension:"
      && CATALOG_BY_ID.has(url.hostname))) return url.href;
    throw new Error("Extension page URL is not allowed in the launcher");
  }

  async createWindow(details = {}) {
    const url = Array.isArray(details.url) ? details.url[0] : details.url;
    const destination = url ? this.extensionPageUrl(url) : null;
    const window = new BrowserWindow({
      width: 920, height: 720, minWidth: 520, minHeight: 420,
      show: false, skipTaskbar: false, title: destination?.startsWith("chrome-extension:")
        ? CATALOG_BY_ID.get(new URL(destination).hostname)?.name || "Browser extension"
        : "Browser extension", autoHideMenuBar: true,
      webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    placeWindowNearLauncher(window, this.parent);
    window.show();
    window.focus();
    this.pages.add(window);
    window.on("close", () => this.unregister(window.webContents));
    window.once("closed", () => this.pages.delete(window));
    window.webContents.setWindowOpenHandler(({ url: opened }) => {
      void this.createTab({ url: opened })
        .catch(error => this.logger.warn("browser.extension_page_rejected", {
          code: error?.code || "extension_page_rejected",
        }));
      return { action: "deny" };
    });
    this.register(window.webContents, window);
    try { if (destination) await window.loadURL(destination); }
    catch (error) { if (!window.isDestroyed()) window.close(); throw error; }
    return window;
  }

  async createTab(details = {}) {
    const destination = this.extensionPageUrl(details.url);
    const window = await this.createWindow({ url: destination });
    return [window.webContents, window];
  }

  async open(id) {
    const extension = this.loaded.get(id);
    if (!CATALOG_BY_ID.has(id) || !extension) {
      throw new Error("Install this Chrome Web Store extension before opening it");
    }
    const popup = extension.manifest?.action?.default_popup;
    if (typeof popup !== "string" || !/^[a-zA-Z0-9_./-]+\.html$/.test(popup)
      || popup.startsWith("/") || popup.split("/").includes("..")) {
      throw new Error("This extension has no supported popup; open it from the browser toolbar");
    }
    await this.createWindow({ url: `chrome-extension://${id}/${popup}` });
    return true;
  }

  destroy() {
    this.api.off("native-messaging-lifecycle", this.nativeHostLifecycle.observe);
    this.nativeHostLifecycle.destroy();
    if (this.autoCheckTimer) clearInterval(this.autoCheckTimer);
    this.autoCheckTimer = null;
    if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer);
    this.initialCheckTimer = null;
    for (const window of [...this.pages]) {
      if (window.isDestroyed()) continue;
      window.close();
      if (!window.isDestroyed()) window.destroy();
    }
    this.pages.clear();
  }

  status() {
    const extension = this.loaded.get(ONE_PASSWORD_EXTENSION_ID);
    return extension
      ? { installed: true, id: extension.id, version: extension.version }
      : { installed: false, id: ONE_PASSWORD_EXTENSION_ID };
  }

  catalogStatus() {
    return {
      providers: BROWSER_EXTENSION_CATALOG.map(provider => {
        const extension = this.loaded.get(provider.id);
        return {
          id: provider.id, name: provider.name, storeUrl: provider.storeUrl,
          note: provider.note || null, installed: !!extension,
          version: extension?.version || null,
          availableVersion: this.availableUpdates.get(provider.id) || null,
        };
      }),
      checking: !!this.checkingUpdates,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  async restore() {
    for (const provider of BROWSER_EXTENSION_CATALOG) {
      try {
        let loaded = this.browserSession.extensions.getExtension(provider.id);
        if (!loaded) {
          const directory = path.join(this.extensionsPath, provider.id);
          if (!existsSync(directory)) continue;
          const versions = readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && existsSync(path.join(directory, entry.name, "manifest.json")));
          if (!versions.length) throw new Error("No complete version is available for restore");
          const reviewed = versions.map(entry => {
            const extensionPath = path.join(directory, entry.name);
            return { extensionPath, manifest: assertReviewedManifest(extensionPath, provider) };
          }).sort((left, right) => compareVersions(right.manifest.version, left.manifest.version));
          loaded = await this.browserSession.extensions.loadExtension(reviewed[0].extensionPath);
        }
        if (loaded.id !== provider.id) {
          this.browserSession.extensions.removeExtension(loaded.id);
          throw new Error("The installed Chrome Web Store identity does not match");
        }
        this.loaded.set(provider.id, loaded);
        this.logger.info("browser.extension_restored", { id: loaded.id, version: loaded.version });
      } catch (error) {
        this.logger.warn("browser.extension_restore_failed", {
          id: provider.id, errorType: error?.name || "Error",
        });
      }
    }
    this.startAutoUpdateChecks();
    return this.status();
  }

  async installOnePassword() {
    await this.install(ONE_PASSWORD_EXTENSION_ID);
    return this.status();
  }

  async install(id) {
    const provider = CATALOG_BY_ID.get(id);
    if (!provider) throw new Error("Choose an extension from the official Chrome Web Store catalog");
    if (this.loaded.has(id)) return this.catalogStatus();
    if (this.installing.has(id)) return this.installing.get(id);
    const operation = (async () => {
      const extensionPath = await downloadExtension(id, this.extensionsPath);
      assertReviewedManifest(extensionPath, provider);
      const loaded = await this.browserSession.extensions.loadExtension(extensionPath);
      if (loaded.id !== id) {
        this.browserSession.extensions.removeExtension(loaded.id);
        throw new Error("The downloaded Chrome Web Store identity does not match");
      }
      this.loaded.set(id, loaded);
      this.logger.info("browser.extension_installed", { id, version: loaded.version });
      return this.catalogStatus();
    })();
    this.installing.set(id, operation);
    try { return await operation; }
    finally { if (this.installing.get(id) === operation) this.installing.delete(id); }
  }

  startAutoUpdateChecks() {
    if (this.autoCheckTimer) return;
    const check = () => { void this.checkUpdates().catch(error => this.logger.warn(
      "browser.extension_update_check_failed", { errorType: error?.name || "Error" },
    )); };
    this.initialCheckTimer = setTimeout(check, 60_000);
    this.initialCheckTimer.unref?.();
    this.autoCheckTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    this.autoCheckTimer.unref?.();
  }

  async checkUpdates() {
    if (this.checkingUpdates) return this.checkingUpdates;
    const operation = (async () => {
      const installed = BROWSER_EXTENSION_CATALOG.filter(provider => this.loaded.has(provider.id));
      if (!installed.length) {
        this.availableUpdates.clear();
        this.lastCheckedAt = new Date().toISOString();
        return this.catalogStatus();
      }
      const chromeVersion = process.versions.chrome;
      const body = { request: {
        "@updater": "codex-web-gpt", acceptformat: "crx3",
        app: installed.map(provider => ({ appid: provider.id, updatecheck: {} })),
        os: { platform: process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform,
          arch: process.arch === "ia32" ? "x86" : process.arch },
        prodversion: chromeVersion, protocol: "3.1",
        requestid: randomUUID(), sessionid: randomUUID(),
      } };
      const response = await fetch(UPDATE_URL, {
        method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/json", "X-Goog-Update-Interactivity": "bg",
          "X-Goog-Update-AppId": installed.map(provider => provider.id).join(","),
          "X-Goog-Update-Updater": `chromiumcrx-${chromeVersion}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("The Chrome Web Store update check failed");
      if (!response.body) throw new Error("The Chrome Web Store update response was empty");
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 512_000) {
          await reader.cancel();
          throw new Error("The Chrome Web Store update response exceeded its size limit");
        }
        chunks.push(Buffer.from(part.value));
      }
      const raw = Buffer.concat(chunks, bytes).toString("utf8");
      const prefix = ")]}'\n";
      if (!raw.startsWith(prefix)) {
        throw new Error("The Chrome Web Store returned an unsupported update response");
      }
      const payload = JSON.parse(raw.slice(prefix.length));
      const updates = new Map();
      for (const app of payload?.response?.app || []) {
        const current = this.loaded.get(app.appid);
        const version = app.updatecheck?.manifest?.version;
        if (!current || app.updatecheck?.status !== "ok"
          || typeof version !== "string" || !/^\d+(?:\.\d+){1,4}$/.test(version)) continue;
        if (compareVersions(current.version, version) < 0) updates.set(app.appid, version);
      }
      this.availableUpdates = updates;
      this.lastCheckedAt = new Date().toISOString();
      this.logger.info("browser.extension_updates_checked", { installed: installed.length, available: updates.size });
      return this.catalogStatus();
    })();
    this.checkingUpdates = operation;
    try { await operation; }
    finally { if (this.checkingUpdates === operation) this.checkingUpdates = null; }
    return this.catalogStatus();
  }

  async update(id) {
    const provider = CATALOG_BY_ID.get(id);
    const old = this.loaded.get(id);
    if (!provider || !old) throw new Error("Install this Chrome Web Store extension before updating it");
    if (!this.availableUpdates.has(id)) return this.catalogStatus();
    const extensionPath = await downloadExtension(id, this.extensionsPath);
    const manifest = assertReviewedManifest(extensionPath, provider);
    if (compareVersions(old.version, manifest.version) >= 0) {
      this.availableUpdates.delete(id);
      return this.catalogStatus();
    }
    this.browserSession.extensions.removeExtension(id);
    try {
      const loaded = await this.browserSession.extensions.loadExtension(extensionPath);
      if (loaded.id !== id) {
        this.browserSession.extensions.removeExtension(loaded.id);
        throw new Error("The updated Chrome Web Store identity does not match");
      }
      this.loaded.set(id, loaded);
      this.availableUpdates.delete(id);
      this.logger.info("browser.extension_updated", { id, previousVersion: old.version, version: loaded.version });
      return this.catalogStatus();
    } catch (error) {
      try {
        const restored = await this.browserSession.extensions.loadExtension(old.path);
        if (restored.id === id) this.loaded.set(id, restored);
      } catch (rollbackError) {
        this.loaded.delete(id);
        this.logger.warn("browser.extension_update_rollback_failed", {
          id, errorType: rollbackError?.name || "Error",
        });
      }
      throw error;
    }
  }
}

module.exports = { BrowserExtensions, ONE_PASSWORD_EXTENSION_ID };
