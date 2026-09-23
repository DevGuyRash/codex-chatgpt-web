const CHROME_WEB_STORE = "https://chromewebstore.google.com/detail";

const BROWSER_EXTENSION_CATALOG = Object.freeze([
  { id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa", name: "1Password", slug: "1password-password-manager" },
  { id: "nngceckbapebfimnlniiiahkandclblb", name: "Bitwarden", slug: "bitwarden-password-manager", note: "Also works with Vaultwarden servers" },
  { id: "bfogiafebfohielmmehodmfbbebbbpei", name: "Keeper", slug: "keeper-password-manager" },
  { id: "hdokiejnpimakedhajhdlcegeplioahd", name: "LastPass", slug: "lastpass-free-password-manager" },
  { id: "fdjamakpfbbddfjaooikfcpapjohcfmg", name: "Dashlane", slug: "dashlane-password-manager" },
  { id: "ghmbeldphafepmbegfdlkpapadhbakde", name: "Proton Pass", slug: "proton-pass" },
].map(provider => Object.freeze({ ...provider,
  storeUrl: `${CHROME_WEB_STORE}/${provider.slug}/${provider.id}`,
})));

// Current official CRX manifests were inspected against the pinned Electron permission
// feature tables. New permissions need another native compatibility review before load.
const REVIEWED_EXTENSION_PERMISSIONS = new Set([
  "activeTab", "alarms", "browsingData", "clipboardRead", "clipboardWrite",
  "contextMenus", "cookies", "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess", "downloads", "idle", "management",
  "nativeMessaging", "notifications", "offscreen", "privacy", "scripting",
  "sidePanel", "storage", "tabs", "unlimitedStorage", "webNavigation",
  "webRequest", "webRequestAuthProvider",
]);

module.exports = { BROWSER_EXTENSION_CATALOG, REVIEWED_EXTENSION_PERMISSIONS };
