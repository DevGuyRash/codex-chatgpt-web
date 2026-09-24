# Development launcher setup

This guide runs the current checkout in an isolated **Codex Web GPT DEV** profile. The normal and DEV launchers can be open together. They may use the same reviewed launcher executable, but `--dev-profile` selects a separate home, Electron `userData`, persistent browser partition, ChatGPT login, diagnostics, tunnel profile, and chat history. DEV does not install a Codex route, start a Responses listener, or change the normal `~/.codex/config.toml`. In the normal launcher's **Settings → Development profile**, **Set up and open DEV** creates or reopens the default isolated profile; **Choose DEV folder** selects an existing profile or a different location. The DEV window then presents its own guided setup. A second binary installer is not needed for two profiles; the existing installers use one product identity and may replace an installed binary when updating it. Keep a different development build at a separate executable path when both binary versions must coexist.

The DEV launcher's Settings has **Open hidden desktop** for an active isolated test workspace. It opens the private browser viewer after checking ownership; choose the workspace folder when prompted. From the checkout, `just golden-viewer-open /path/to/workspace` opens it directly, and `just golden-viewer-url /path/to/workspace` prints the private URL for a browser on the same machine. A hidden workspace is a separate Linux display, distinct from the normal DEV profile, and its launcher is visible inside noVNC after connecting. Do not share the private viewer URL or record authentication screens.

## Build and launch

Use Bun 1.4.0 and install the repository's locked dependencies:

```bash
just bootstrap
```

Build the reviewed Electron 44.4.4 WebAuthn runtime as described in [Embedded WebAuthn runtime](../native/electron/README.md). Stock Electron cannot satisfy the launcher's PIN and phone request contract. Keep its build directory and caches on a volume with enough space; the build instructions use `/ai_models` on this Linux development host.

For source development, point the launcher at the resulting native executable and start its Vite-backed window:

```bash
export CODEX_WEB_GPT_ELECTRON_EXECUTABLE=/absolute/build/root/src/out/Release/electron
bun run launcher:dev
```

The window title includes **DEV**. Keep this command running while using the browser or the DEV chat harness. To build and smoke-test a package from the same native runtime instead, set the reviewed `dist.zip` and an absolute artifact directory, then run:

```bash
export CODEX_WEB_GPT_ELECTRON_DIST=/absolute/build/root/src/out/Release/dist.zip
export CODEX_WEB_GPT_ARTIFACTS_DIR=/absolute/artifact/directory
bun run app:package
bun run app:smoke
```

These commands build a package for the host OS and do not install it, publish it, or replace the normal app. The package and smoke check reject a missing or mismatched native build record. On Linux the output is an AppImage; on macOS it is a ZIP/DMG, and on Windows an installer. Native builds and real authentication must be checked on each target OS.

To launch an already installed or extracted reviewed package as DEV, point the repository command at its absolute executable path:

```bash
CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=/absolute/path/to/launcher bun run dev:launcher
bun run src/cli.ts dev status
```

`dev:launcher` returns the active DEV launcher when one already owns the profile. To start a stopped profile, it requires `CODEX_WEB_GPT_LAUNCHER_EXECUTABLE` set to the absolute path of a reviewed packaged executable. It never guesses the normal installed executable: a stock or differently packaged release may lack this fork's WebAuthn identity record and fail during startup. On Linux, select the extracted package's `AppRun`; on macOS, select the app bundle's `Contents/MacOS/Codex Web GPT`; on Windows, select the packaged launcher `.exe`. The command passes `--dev-profile`; the profile choice comes from the command, not the executable filename. To restart onto another build, quit the running DEV launcher first, then run the command with that build's explicit path. `CODEX_WEB_GPT_DEV_HOME` may select another absolute DEV home; the default is `~/.codex-chatgpt-web-dev`. Do not set it to the production home. The temporary isolated home used for one maintainer test is not a default or a shared user profile.

For a clickable Linux shortcut, create a separate desktop entry named **Codex Web GPT DEV** whose `Exec` selects both the reviewed package and DEV home. For example, use the following fields in `~/.local/share/applications/codex-web-gpt-dev.desktop`, replacing both absolute paths with your own:

```ini
[Desktop Entry]
Type=Application
Name=Codex Web GPT DEV
Exec=/usr/bin/env CODEX_WEB_GPT_DEV_HOME=/absolute/dev/home /absolute/reviewed/AppRun --dev-profile
TryExec=/absolute/reviewed/AppRun
Icon=codex-web-gpt
Terminal=false
Categories=Development;
StartupWMClass=codex-web-gpt-dev
```

The normal launcher's Settings action launches the DEV profile on Linux, macOS, and Windows. A packaged Linux launcher also creates a separate DEV desktop entry when no user-managed entry occupies that name; it leaves a user-managed entry unchanged. The same executable-and-profile rule applies on other platforms: a macOS shortcut or wrapper should launch the reviewed app bundle executable with `CODEX_WEB_GPT_DEV_HOME` and `--dev-profile`; a Windows shortcut or PowerShell wrapper should launch the reviewed packaged `.exe` with the same DEV home environment and `--dev-profile`. The normal desktop icon and a source-channel shortcut can target different binaries or profiles, so their titles alone are not proof that a DEV profile is running. Check the **DEV** badge and `bun run src/cli.ts dev status` after launch. Distinct macOS and Windows shortcut installers are not yet supplied by this repository.

Linux 1Password desktop integration has an additional packaging constraint: on the tested host, its native host trusted a stable root-owned extracted launcher tree under `/opt`, but rejected portable AppImage mounting and user-owned extraction. After package smoke passes, extract the reviewed AppImage as your normal user, compute the SHA-256 of its `resources/app.asar`, and run the repository installer in a visible terminal:

```bash
mkdir -p /absolute/staging/directory
cd /absolute/staging/directory
/absolute/artifacts/REVIEWED.AppImage --appimage-extract >/dev/null
sha256sum squashfs-root/resources/app.asar squashfs-root/resources/runtime/app/cli.js
sudo bash /absolute/repo/scripts/install-linux-extracted-app.sh /absolute/staging/directory/squashfs-root /opt/codex-web-gpt-dev/app-reviewed EXPECTED_APP_ASAR_SHA256 EXPECTED_RUNTIME_CLI_SHA256
```

The installer refuses an existing destination, preserves root ownership, makes extracted directories traversable, removes group/world write access, and verifies the installed launcher `app.asar` and bundled runtime CLI hashes. Select the installed `AppRun` as the DEV executable only after that verification; the normal installation remains separate. The official 1Password extension is installed only when selected in the launcher's extension catalog, and its desktop application and additional-browser trust step are separate. See [Embedded browser authentication](browser-authentication.md) before testing 1Password. Hardware-key login does not require installing that extension. This Linux install does not establish Windows or macOS provider trust; those platforms use their own packaged app identity and need separate real-device acceptance.

## Initialize the isolated profile

Sign in inside the **DEV** window, inspect the saved session, and run the browser smoke test. Choose browser-only setup first when checking sign-in, WebAuthn, layout, model selection, or compaction. Full setup is needed for MCP tools. The DEV profile can use a different ChatGPT account and will not copy cookies or credentials from the normal launcher.

For a simple working-tree browser turn after setup:

```bash
bun run dev:chat smoke "Reply with exactly: DEV READY"
```

The named DEV chat uses the current checkout and isolated browser. Browser-only mode exposes no outer tools. Full mode exercises the MCP path with explicit simulated tool receipts; it is not a native Codex task or proof that a file-changing tool ran. See [DEV chat harness](dev-chat.md) for persistent chats, model choice, and compaction commands.

## Prepare a separate DEV tunnel and ChatGPT app

The DEV launcher's **MCP** wizard provides the visual walkthrough, copyable tunnel and app names/descriptions, and checks for workspace association and ordinary Chat availability. Its checks are guidance; **Verify runtime** is the actual connector test. The DEV connector step uses a DEV-specific reference instead of the normal setup's video, which shows the production name.

Create a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels) named **Codex Web GPT DEV MCP**. Its description can be: “Private tunnel for the isolated Codex Web GPT DEV launcher and its local MCP tool tests. Production uses a separate connector.” Associate it with the **ChatGPT workspace in which the DEV account will create and use the app**, as well as the intended Platform organization. A tunnel attached only to a Platform organization may be healthy locally but absent from ChatGPT's app form. The creator needs Tunnels **Read + Use** and ChatGPT developer-mode access; tunnel creation/editing additionally requires **Read + Manage**. [OpenAI's Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels/) describes these separate permissions and associations.

Before creating the app, configure Full mode in the DEV launcher's **MCP** page using the new tunnel's ID and a runtime API key with Tunnels Read + Use. The DEV profile stores its own `0600` key copy under its isolated home. You may create a separate DEV key, or explicitly reuse an existing key that has access to the new tunnel; the production key file and production configuration are not changed. When replacing an already configured DEV tunnel, choose **Change tunnel · keep saved DEV key** to change only the tunnel ID, or **Change tunnel · enter a different DEV key** to store a separate value. The saved-key option never reads from the production key file. The CLI also accepts `--runtime-key-file` without printing the key. Never put a runtime key in a ChatGPT app description, a URL, a diagnostic export, or a chat message. The isolated DEV tunnel must report ready for the **same tunnel selected in ChatGPT** while ChatGPT discovers tools; readiness of an earlier tunnel is not enough.

The intended app name is **Codex Native2 DEV**, with description “Isolated development connector for Codex Web GPT local tools and test receipts; not the production Codex connector.” A Tunnel connection should use **No authentication** in the app form: the runtime key authenticates the local tunnel client to the tunnel service and is not an app-form secret. Leave the existing **Codex Native2** production app unchanged.

The [current OpenAI Plugins quickstart](https://developers.openai.com/plugins/quickstart) creates a personal plugin through [ChatGPT Plugins](https://chatgpt.com/plugins) and tests it in **ChatGPT Work**. This checkout's browser driver uses ordinary **Chat**, so a redirect from **Create plugin** to `chatgpt.com/?surface=work` is a real compatibility question, not proof that a usable DEV connector was created. Verify that a newly created tunnel app is actually selectable and callable from the ordinary Chat surface before treating Full DEV setup as complete. If it is offered only in Work, leave this flow pending rather than moving the driver to Work or borrowing the production connector without review.

In Platform tunnel settings, check that the new tunnel's **Workspaces** association includes the intended ChatGPT workspace; if an app form shows “No tunnels yet,” also check Tunnels **Use** permission and refresh after the association becomes visible. Do not paste the hosted tunnel URL as `server_url`. Do not share the tunnel ID or runtime key when reporting an account-side problem.

## Verify and clean up

Use `bun run src/cli.ts dev status` to check the selected profile, and run the launcher browser smoke test before account-bound flows. For local source checks, `just ci` runs the repository verification; `bun run app:smoke` checks the package without claiming a real login. Keep live synthetic generations serial initially and never run more than two active non-Pro generations including children. Pro and model substitution remain outside this DEV acceptance.

Quit the DEV window to stop its owned browser and tunnel. A named `dev:chat` command releases its broker when it exits. The normal launcher and its configuration are separate; do not delete either profile to troubleshoot the other. DEV diagnostic exports may still contain account or task metadata, so inspect them before sharing.
