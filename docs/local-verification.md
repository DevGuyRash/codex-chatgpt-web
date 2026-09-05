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

Verification uses temporary build directories and removes them on exit. If the default temporary filesystem has a space or user-quota limit, set `CODEX_CHATGPT_WEB_VERIFY_SCRATCH_ROOT` to an existing writable directory with sufficient space for runtime bundles; this keeps latency-sensitive tests and Unix sockets on their normal temporary filesystem. Native packaging may use standard `TMPDIR` for its larger staging directories. Use a short disk-backed path for native launcher smoke tests, such as `/var/tmp` on Linux: deeply nested scratch paths can prevent Electron startup because its Unix-domain socket paths are length-limited. Keep machine-specific choices outside tracked files; do not delete unrelated caches to satisfy a build.

For shorter feedback loops, use `just test` and `just typecheck`. Run `just ci` before integrating a batch into main.

## Native packaging

On Windows, use a disposable test account or VM: the existing package-smoke script installs the current-user package and can replace that account's installed launcher. Linux and macOS smoke tests use temporary application/profile paths.

```sh
just ci-native
```

This additionally invokes the existing native packaging and packaged-launcher smoke scripts. Those require the same platform dependencies as the repository's CI workflow, including the supported Linux libnotify/AppImage tools and an available display or Xvfb where appropriate. `just native-package` and `just native-smoke` run those phases separately. Packaging replaces generated artifacts in the launcher's artifact directory but does not replace the installed application.

On Linux, prepare the owned AppImage toolset before native packaging. With the development dependencies listed in the release workflow installed, run these commands from the repository root in the same shell as `just ci-native`:

```sh
export CODEX_WEB_GPT_LINUX_LIBNOTIFY="$(./scripts/prepare-linux-libnotify.sh)"
export APPIMAGE_TOOLS_PATH="$(bun run launcher/scripts/prepare-linux-appimage-tools.cjs)"
just ci-native
```

The first step builds the pinned, checksum-verified libnotify; the second prepares a repository-owned copy of the AppImage toolset containing that library. It does not modify the shared downloaded toolset. The packaged-symbol smoke test checks the resulting artifact, so a successful package build alone is not enough.

A Linux run is not Windows or macOS acceptance. Native installers must be built and tested on their matching operating systems. The hosted workflow's Windows PowerShell compatibility, macOS signing, and Linux-on-Arch ABI checks remain separate platform checks; passing `just ci` must not be described as passing those checks.

GitHub workflow scheduling is independent of these local commands. Disabling the fork's CI workflow prevents pushes from spending Actions minutes; it does not disable local verification. Re-enable it deliberately when hosted verification is wanted again.
