const bridge = window.codexPasskeyPrompt;
const element = id => document.getElementById(id);
let current = null;

function showError(message) {
  element("error").textContent = message;
  element("error").hidden = false;
}

async function reply(action, extra = {}) {
  if (!current) return;
  if (!bridge) { showError("The launcher prompt bridge is unavailable. Close this window and retry sign-in."); return; }
  const accepted = await bridge.respond({ id: current.id, action, ...extra });
  if (!accepted) showError("This passkey request is no longer active. Return to the sign-in page and try again.");
}

function render(state) {
  const changed = current?.id !== state.id || current?.error !== state.error || current?.kind !== state.kind;
  current = state;
  element("error").hidden = true;
  element("site").textContent = state.origin + " · " + state.relyingPartyId;
  element("method-section").hidden = state.kind !== "method";
  element("touch-section").hidden = state.kind !== "touch";
  element("verification-section").hidden = state.kind !== "verification";
  element("pin-form").hidden = state.kind !== "pin";
  element("qr-section").hidden = state.kind !== "qr";
  element("account-section").hidden = state.kind !== "account";
  if (state.kind === "method") {
    element("title").textContent = "Choose a passkey method";
    element("help").textContent = "Choose where your passkey is stored. The sign-in request stays in this browser.";
    element("method-security-key").hidden = !state.securityKeyAvailable;
    element("method-phone").hidden = !state.phoneAvailable;
    element("method-device").hidden = !state.platformAvailable;
    const extensions = element("method-extensions");
    extensions.replaceChildren();
    for (const provider of state.extensionProviders || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Open " + provider.name;
      button.addEventListener("click", () => { void reply("use-extension", { extensionId: provider.id }); });
      extensions.append(button);
    }
    element("method-extension-hint").hidden = !(state.extensionProviders || []).length;
  } else if (state.kind === "touch") {
    element("title").textContent = "Touch your security key";
    element("help").textContent = "Keep this window open while the key verifies the request.";
    element("touch-phone").hidden = !state.phoneAvailable;
  } else if (state.kind === "verification") {
    element("title").textContent = "Verify on this device";
    element("help").textContent = "Complete the native verification prompt to continue.";
    element("verification-hint").textContent = Number.isInteger(state.verificationAttempts)
      ? "Verification was not accepted. " + state.verificationAttempts + " attempts remain."
      : "Use your device's supported passkey authenticator.";
    element("verification-phone").hidden = !state.phoneAvailable;
  } else if (state.kind === "pin") {
    element("title").textContent = state.reason === "set" ? "Set a security key PIN"
      : state.reason === "change" ? "Change your security key PIN" : "Unlock your security key";
    element("help").textContent = state.error === "wrong-pin" ? "That PIN was not accepted by the key."
      : state.error === "internal-uv-locked" ? "The key's built-in verification is locked. Enter its PIN."
      : state.error === "too-short" ? "That PIN is shorter than the key allows."
      : state.error === "invalid-characters" ? "The key rejected characters in that PIN."
      : state.error === "same-as-current" ? "Choose a PIN different from the current one."
      : "Enter the PIN for your security key. You will still need to touch the key.";
    const attempts = Number.isInteger(state.attempts) && state.attempts > 0 ? state.attempts : null;
    element("pin-hint").textContent = "Minimum " + (state.minPinLength || 1) + " characters."
      + (attempts ? " " + attempts + " attempts remain." : "");
    element("pin").minLength = state.minPinLength || 1;
    element("pin-phone").hidden = !state.phoneAvailable;
    element("pin-methods").hidden = !(state.extensionProviders || []).length && !state.platformAvailable;
    if (changed) element("pin").value = "";
    element("pin").focus();
  } else if (state.kind === "qr") {
    element("title").textContent = "Use a phone passkey";
    element("help").textContent = "Scan this QR code with your phone, then follow its prompts.";
    element("qr").src = state.qrDataUrl || "";
    element("qr").hidden = !state.qrDataUrl;
    element("security-key-action").hidden = !state.securityKeyAvailable;
    element("qr-methods").hidden = !(state.extensionProviders || []).length && !state.platformAvailable;
    element("phone-progress").textContent = state.hybridProgress === "phone-connected"
      ? "Phone connected. Keep it nearby and confirm the passkey request."
      : state.hybridProgress === "bluetooth-seen" ? "Phone found over Bluetooth. Establishing a secure connection…"
      : state.hybridProgress === "ready" ? "Phone is ready. Confirm the passkey request on your phone."
      : state.qrDataUrl ? "Waiting for your phone to scan the QR code…" : "Preparing a fresh QR code…";
    const status = state.bluetoothStatus;
    element("bluetooth-status").textContent = status === "on" ? "Bluetooth is ready."
      : status === "permission-required" ? "Bluetooth permission is needed to connect."
      : status === "permission-denied" ? "Bluetooth permission was denied."
      : "Bluetooth is off or unavailable.";
    const action = element("bluetooth-action");
    action.hidden = !(status === "permission-required" || (status === "off" && state.canPowerOnBluetooth));
    action.textContent = status === "permission-required" ? "Allow Bluetooth" : "Turn on Bluetooth";
    action.dataset.action = status === "permission-required" ? "request-bluetooth-permission" : "power-on-bluetooth";
  } else if (state.kind === "account") {
    element("title").textContent = "Choose a passkey";
    element("help").textContent = "Select the account you want to use for this sign-in.";
    const list = element("accounts");
    list.replaceChildren();
    for (const account of state.accounts || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = account.name;
      button.addEventListener("click", () => { void reply("select-account", { credentialId: account.credentialId }); });
      list.append(button);
    }
  }
}

if (!bridge || typeof bridge.current !== "function") {
  element("title").textContent = "Passkey prompt unavailable";
  showError("The launcher could not connect to this passkey request. Close this window and retry sign-in.");
} else {
  bridge.onState(render);
  bridge.onWaiting(id => {
    if (current?.id !== id) return;
    element("title").textContent = "Checking your security key";
    element("help").textContent = "Touch the key when it flashes.";
    element("pin-form").hidden = true;
  });
  void bridge.current().then(state => {
    if (state) render(state);
    else window.close();
  }).catch(() => {
    element("title").textContent = "Passkey prompt unavailable";
    showError("The launcher could not read this passkey request. Close this window and retry sign-in.");
  });
}
element("pin-form").addEventListener("submit", event => {
  event.preventDefault();
  const pin = element("pin").value;
  if (pin.length < (current?.minPinLength || 1)) {
    showError("The PIN is shorter than this key allows.");
    return;
  }
  void reply("submit-pin", { pin }).finally(() => { element("pin").value = ""; });
});
element("bluetooth-action").addEventListener("click", () => {
  void reply(element("bluetooth-action").dataset.action);
});
element("method-security-key").addEventListener("click", () => { void reply("use-security-key"); });
element("method-phone").addEventListener("click", () => { void reply("use-phone"); });
element("method-device").addEventListener("click", () => { void reply("use-device"); });
element("touch-phone").addEventListener("click", () => { void reply("use-phone"); });
element("pin-phone").addEventListener("click", () => { void reply("use-phone"); });
element("pin-methods").addEventListener("click", () => { void reply("choose-method"); });
element("verification-phone").addEventListener("click", () => { void reply("use-phone"); });
element("security-key-action").addEventListener("click", () => { void reply("use-security-key"); });
element("qr-methods").addEventListener("click", () => { void reply("choose-method"); });
