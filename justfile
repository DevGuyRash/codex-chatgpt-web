# project-harness: managed-file
# Local verification: just bootstrap; just browser-install; just ci
# Native distribution checks: just ci-native (builds locally; never publishes)
# Override CODEX_CHATGPT_WEB_BUN and CHATGPT_TEST_CHROME_EXECUTABLE when needed.

set shell := ["bash", "-uc"]
set windows-shell := ["bash", "-uc"]

bun := env("CODEX_CHATGPT_WEB_BUN", "bun")

# List the repository's local verification commands
default:
    @just --list

# Install locked root and launcher dependencies with the selected Bun runtime
bootstrap:
    {{ quote(bun) }} install --frozen-lockfile
    {{ quote(bun) }} install --frozen-lockfile --cwd launcher

# Download the Playwright-pinned Chromium used by offline browser fixtures
browser-install:
    {{ quote(bun) }} x --no-install playwright-core install chromium

# Verify root and launcher code, audits, builds, offline Chromium fixtures, and workflows
ci:
    CHATGPT_TEST_CHROME_EXECUTABLE="${CHATGPT_TEST_CHROME_EXECUTABLE:-$({{ quote(bun) }} -e 'import { chromium } from "playwright-core"; console.log(chromium.executablePath())')}" {{ quote(bun) }} run verify
    actionlint .github/workflows/*.yml

# Run root and launcher behavior tests without packaging or dependency audits
test:
    {{ quote(bun) }} run test
    {{ quote(bun) }} run launcher:test

# Type-check root TypeScript and the launcher renderer
typecheck:
    {{ quote(bun) }} run typecheck
    {{ quote(bun) }} run launcher:typecheck

# Build the launcher installer for this operating system without publishing
native-package:
    {{ quote(bun) }} run app:package

# Smoke-test the native package without ChatGPT prompts (Windows installs into the current account)
native-smoke:
    {{ quote(bun) }} run app:smoke

# Run local CI and then build and smoke-test this operating system's launcher package
ci-native: ci native-package native-smoke
