# Selective upstream review: 5.0.4

The review compares fork baseline `ec03b9a` with upstream `c648c09501bb1b704c7ad5273fb5f5d6b8992dd2`. It is a selective integration, not acceptance of the complete upstream release or a claim of universal bug-freedom. The fork's typed diagnostics, source-aware configuration repair, Native feature choices, exact physical cleanup, approval requirements and local verification policy remain authoritative.

## Accepted changes

| Upstream source | Integrated behavior | Evidence |
| --- | --- | --- |
| `3b0ac80` | Observe fresh assistant DOM before expiring the response grace, while retaining the explicit turn deadline. | The delayed-wake regression failed on the fork baseline and passed after the change; it also covers a genuinely missing assistant and the explicit deadline. |
| `b536fdb` | Publish the MCP token only after prompt preparation succeeds. | A synthetic Luna preparation failure previously surfaced as an expired token; the adapter test now receives the original preparation error without emitting a tool call. |
| `b536fdb` | End the manual confirmation deadline at Sent, without timing out slow first-MCP startup. | Controlled-clock host tests prove pre-Sent timeout, post-Sent waiting and eventual completion. Existing cancellation, tab-close and owner-exit tests remain in force. The rendered sent state has no zero-second countdown. |
| `b536fdb` | Reconcile model/effort on a retained conversation before the next prompt. | A test invokes the actual worker orchestration with substituted browser seams, proves the selection boundary precedes prompt work and preserves the borrowed page and continuation cleanup. It failed before the change. |
| `b536fdb` | Own a rebound browser connection before validating its viewport. | An isolated subprocess substitutes the CDP transport and forces viewport failure. The old connection closes before reacquisition and the new connection closes on failure, exactly once each. The baseline leaked the second connection. |
| `4d10d12` | Give a verified final MCP step its completed visual treatment. | Real App/Chromium rendering checks verified and unverified states in English, Simplified Chinese and Japanese; the verified case failed before the change. |

The upstream test-only changes that disable persisted response history for compaction and Lite-tools fixtures are also included. They isolate synthetic tests without changing production response persistence.

## Changes not accepted as written

**Compaction filtering:** the upstream filter drops an entire user message if any text block matches an internal-context XML wrapper. An untouched-upstream probe supplied two explicitly human text blocks, one explanatory sentence and one XML example; the result was an empty message list. This would lose genuine user input. The fork keeps its existing behavior and now has a regression preserving this case. A future goal-context fix must distinguish authoritative internal context from human examples rather than treating text shape as authority.

**Native steering:** the upstream lineage check is confined to a still-active physical owner. An untouched-upstream probe completed the newer instruction and its physical cleanup, then submitted a previously unseen predecessor; the older request started instead of being rejected. This is incomplete late-request protection, not evidence that upstream introduced every form of stale replay. The steering change is deferred until supersession covers terminal/retained history and compaction boundaries without reviving older work or rejecting valid continuations.

**Hook rewriting:** upstream's relaxed textual matching is not substituted for the fork's stronger parsed ownership and source-aware restoration. An added regression starts with LF, CRLF and CR originals, simulates native-editor normalization to LF, and confirms that tables inserted before the trailing marker survive verification/removal while changed hook values remain protected.

**Legacy diagnostics changes:** the connector DOM snapshot adjustment targets the removed legacy collector. The additional Markdown conflict stderr payload is not brought in as a parallel diagnostic path; any future detail should use the fork's structured diagnostic contract and privacy controls.

**Release metadata:** the upstream 5.0.4 version/installer default bump is not included. This selective fork build is not the complete upstream 5.0.4 release, and no release is published.

## Verification boundary

Targeted regressions exercise adapter orchestration, browser ownership, manual host lifecycle and rendered launcher presentation. Browser/CDP/launcher state is substituted where noted; none of these tests sends a live ChatGPT message. The hook and compaction tests exercise the actual parsers and transformations. Native Windows/macOS behavior and live provider behavior are not established by these Linux fixtures.

The final ordered `bun run verify` gate passed 974 core tests (4,366 assertions), 318 launcher tests and 15 browser/UI tests (353 assertions), including type checks, dependency audits, builds, the offline Codex capability probe and relocated runtime/diagnostics smoke checks. Packaging and the Linux x64 packaged smoke check also passed. The AppImage SHA-256 is `c756a5198aedc95013ed366a9a67eae5b7555247d9febdcb917b575ffa4a7b5a`. These are acceptance results for this reviewed source, not a promise about future provider changes or an untested platform.

## Agent review before main integration

Two independent review agents assessed candidate `d96a426` before integration into fork `main`. One compared every production change in the selective upstream commit with its upstream source and checked runtime ownership, failure propagation, manual lifecycle and relevant diagnostic/repair interfaces; the other inspected the generalized repair boundary from `33ebd7e`, including Native choices, ambiguous comments, indexed TOML edits, hook identity and exact approval binding. Neither reported a material finding in its scope. The minor line-ending evidence wording identified by the first review is corrected above.

Independent reruns passed 215 targeted core tests (1,060 assertions), 96 browser-host tests, the rendered multilingual regression (25 assertions), and 153 repair/source/TOML/hook/review tests. Additional in-memory repair probes rejected competing disabled definitions, unknown hook properties and changed command identity. The agents did not perform live provider operations or real configuration changes, and their reviews do not represent an exhaustive re-audit of every diagnostics implementation detail. The persistent upstream-integration rule is recorded in the root `AGENTS.md`.
