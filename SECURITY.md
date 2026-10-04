# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though
this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP
adapter to patched 2.0.12. `bun audit`, the MCP protocol test, and the compiled-binary smoke test are
release gates; remove the override when the stable SDK itself moves to the patched major.

The launcher lockfile resolves `http-cache-semantics` to upstream 4.3.0, which fixes
[Vary wildcard/header matching](https://github.com/kornelski/http-cache-semantics/commit/9fb520be70eff3ff502fe965d9c3265ca2c64e26).
As of 2026-10-04, normal dependency audits pass because
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) lists only versions through
4.2.0. Its disputed `max-stale` semantics are unchanged in 4.3.0; this update does not claim to fix
that advisory. [Upstream's dispute is still under advisory review](https://github.com/github/advisory-database/issues/10139).
The dependency is limited to launcher build tooling, whose current downloader leaves Got HTTP
caching disabled. Focused tests check that boundary and retain its proxy, timeout and retry
contracts; no HTTP-cache exposure is demonstrated in this application path. Reassess if that path
or the advisory changes. No audit exclusions or security waivers are applied.

Once the GitHub repository is public, use its private Security Advisory reporting flow. Until that
is enabled, do not publish a proof of concept that exposes credentials or arbitrary local tool
execution; contact the maintainer privately through the GitHub account listed by the repository.
