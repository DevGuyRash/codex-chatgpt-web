# Upstream v5.0.3 integration review

The integration combines the fork's signed configuration-transaction work with upstream through `74aed4025937eadca13b363cdcbc87963cd4dff3`. The four upstream commits were reviewed individually and then against the combined cleanup and configuration contracts.

| Commit | Scope and disposition |
| --- | --- |
| `740c4eaa` | Browser-control, MCP completion, capability refresh, and compaction recovery changes retained with behavior coverage. Model rows are not interpreted as reasoning-effort choices. |
| `26a6b03c` | Redundant source-text assertions removed. Acceptance follows observable behavior rather than test count. |
| `a3a5083f` | Compaction progress/cleanup changes retained. The fork's exact-turn cleanup accessor now waits for the physical-settlement promise, not the result promise. |
| `74aed402` | v5.0.3 version/release metadata retained without creating a release or enabling hosted CI. |

The result/settlement interaction was a semantic conflict despite a clean textual merge. `compaction-cleanup-settlement.test.ts` holds physical cleanup behind a barrier after the result rejects, proving that exact-turn cleanup cannot complete early. Retained-compaction, server-lifecycle, interrupt-cleanup, and concurrent-profile tests continue protecting ownership, cancellation, and profile isolation.

Removed browser source assertions are covered by behavioral tests for single-send observation recovery, bounded Bigger Context send activation, compaction prompt attachment before submission, localized rate-limit handling, current-turn MCP acceptance, and commentary/answer separation in a real DOM. Capability fixtures cover delayed containers, hidden semantic sliders, older visible sliders, missing controls, and malformed ranges. Ambiguous radio/model rows remain unsupported; their count cannot silently become an account capability. Launcher logout and Japanese persistence have behavior tests, while the new review and restart surfaces are exercised in English, Chinese, and Japanese. Purely decorative markup assertions were not preserved.

Configuration previews still bind target, protocol, resolutions, snapshots, and prepared output. Discovery does not confer write ownership on linked profiles. Restart fixtures never close the developer's Codex instance. Local CI and Linux package smoke are separate from authenticated model/MCP acceptance and native Windows/macOS adapter validation; this integration does not claim those unrun environments or publish a release.
