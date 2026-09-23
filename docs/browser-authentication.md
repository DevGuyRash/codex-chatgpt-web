# Embedded browser authentication

The launcher keeps ChatGPT sign-in inside its persistent Electron browser partition. Chromium owns WebAuthn origin, relying-party, and frame validation; the patched native delegate reports method availability, security-key PIN and touch, account selection, phone QR and Bluetooth progress, cancellation, and terminal failures to one launcher-owned prompt controller. Every reply is bound to the originating frame and current document. PINs, QR pairing secrets, credential material, and sign-in page content stay outside diagnostics and browser capture.

The method screen offers the transports Chromium reports for the current request. A connected security key may request its PIN before the user chooses a method; the controller retains that callback while showing phone, device, and installed extension choices. Selecting an installed password manager cancels the current native request, opens its popup in the same persistent partition, and asks the user to retry the site's passkey step after unlocking. This makes the provider handoff explicit without claiming that opening a popup produced an assertion.

The native patch set is pinned to Electron 44.4.4 and its Chromium revision in `native/electron/manifest.json`. Linux's BlueZ-specific patch retries scan start with weak callbacks and shares an `InProgress` scan only when the adapter confirms active discovery. Windows and macOS retain their native authenticator interfaces; each platform must build its own patched Electron artifact and verify real hardware, phone, and provider behavior locally. Package, development, startup, and smoke commands require the reviewed binary and reject a stock runtime.

Password-manager extensions are optional. The launcher installs only a provider the user selects from its official Chrome Web Store catalog, verifies the CRX identity, and checks declared permissions before native loading. A saved extension restores on restart. Automatic availability checks run after startup and every five hours; **Check for updates** runs on demand. Neither check installs an update. The user chooses **Update** for an available version, and the launcher keeps the prior package available for rollback if loading the new one fails.

| Provider | Official Chrome Web Store ID | Notes |
| --- | --- | --- |
| 1Password | `aeblfdkhhhdcdjpifhhbdiojplfjncoa` | Uses the installed 1Password native host when supported and trusted by that platform. |
| Bitwarden | `nngceckbapebfimnlniiiahkandclblb` | The same extension can connect to a Vaultwarden server. |
| Keeper | `bfogiafebfohielmmehodmfbbebbbpei` | Installed on request. |
| LastPass | `hdokiejnpimakedhajhdlcegeplioahd` | Installed on request. |
| Dashlane | `fdjamakpfbbddfjaooikfcpapjohcfmg` | Installed on request. |
| Proton Pass | `ghmbeldphafepmbegfdlkpapadhbakde` | Installed on request. |

The catalog uses links under `https://chromewebstore.google.com/detail/`; the updater queries Google's official extension update service and downloads updates through the same CRX identity-checking path. The GPL `electron-chrome-extensions` adapter and its notices are included in the package. Its native-messaging host lookup covers Linux, macOS, and Windows, but a desktop password manager may require a separate platform-specific additional-browser trust step for the packaged launcher executable. The launcher never copies a user's Chrome profile.

An extension loading successfully does not establish that its passkeys work. Current Linux evidence includes a real YubiKey PIN-and-touch sign-in and saved-session restoration, and structural loading of the listed extensions. Phone/QR completion, 1Password native-host assertion, other provider assertions, and Windows/macOS real-device acceptance remain open in `context/state.md`.
