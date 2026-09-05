# Local CI

The `justfile` wraps the existing package scripts; it does not introduce a second build or test implementation. These commands do not use GitHub Actions minutes, publish releases, or submit ChatGPT prompts. The offline browser fixture runs against synthetic HTML with page network requests blocked.

Install the repository-pinned Bun, Node.js, `just`, `actionlint`, and Bash (Git Bash on Windows). Then run:

```sh
just bootstrap
just browser-install
just ci
```

`just ci` runs the canonical `bun run verify` pipeline and workflow linting. It explicitly selects a real Chromium executable so the connector fixture is exercised rather than skipped. The default is Playwright's installed Chromium; `just browser-install` downloads the version selected by the lockfile. Browser operating-system libraries must also be available; this recipe does not install privileged system packages.

Set `CODEX_CHATGPT_WEB_BUN` to an absolute Bun executable to use a particular installed runtime. Set `CHATGPT_TEST_CHROME_EXECUTABLE` to use another compatible Chromium installation. Neither override belongs in tracked files. An explicitly selected missing or unusable browser fails verification instead of silently skipping browser tests.

For shorter feedback loops, use `just test` and `just typecheck`. Run `just ci` before integrating a batch into main.

## Native packaging

On Windows, use a disposable test account or VM: the existing package-smoke script installs the current-user package and can replace that account's installed launcher. Linux and macOS smoke tests use temporary application/profile paths.

```sh
just ci-native
```

This additionally invokes the existing native packaging and packaged-launcher smoke scripts. Those require the same platform dependencies as the repository's CI workflow, including the supported Linux libnotify/AppImage tools and an available display or Xvfb where appropriate. `just native-package` and `just native-smoke` run those phases separately. Packaging replaces generated artifacts in the launcher's artifact directory but does not replace the installed application.

A Linux run is not Windows or macOS acceptance. Native installers must be built and tested on their matching operating systems. The hosted workflow's Windows PowerShell compatibility, macOS signing, and Linux-on-Arch ABI checks remain separate platform checks; passing `just ci` must not be described as passing those checks.

GitHub workflow scheduling is independent of these local commands. Disabling the fork's CI workflow prevents pushes from spending Actions minutes; it does not disable local verification. Re-enable it deliberately when hosted verification is wanted again.
