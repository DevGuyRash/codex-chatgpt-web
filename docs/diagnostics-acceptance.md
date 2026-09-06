# Diagnostics acceptance record

This records the September 6, 2026 Linux correctness/UX sweep. Automated checks and native checks have different boundaries; neither substitutes for the other. Synthetic inputs and destructive/private-capture checks use `/var/tmp/cgw-native-9fEP6g`, not the user's real history. Native checks use the actual Linux AppImage, Electron renderer/preload/host, bundled worker, SQLite, desktop clipboard, and KDE save picker. No model messages are submitted.

## Control-by-control evidence

| Control or workflow | Automated evidence | Native evidence and limits |
| --- | --- | --- |
| Overview, runtime health, collection health | Separate health/capture observation, incomplete evidence, grouping signatures and chronological ordering | Synthetic Overview displayed 150 grouped occurrences with first/latest dates; every occurrence was reached through three pages. Healthy collection was not presented as resolution of historical errors. |
| Operations, selection, timeline, Load more | Terminal evidence beats delayed starts; nested, parallel and missing-parent stages; independent list/timeline cancellation | Selected operation 150 remained Cancelled despite a delayed running record. Its timeline loaded all 216 records; nested indentation, parent labels and continuous rail were inspected visually. |
| Advanced search and filters | Full text/regex, invalid regex/trace/date, task/component/target/severity filters, empty results, independent query identities | Regex and trace validation, search-mode changes and component/target/severity selection exercised natively. Physical input coverage is reported separately below. |
| Pause, Resume, Refresh, New activity | Paused lists with live health/capture expiry; explicit refresh/search; superseded responses; older-inspection preservation; delayed foreground cancellation | Native pause/refresh controls exercised; deterministic cancellation, expiry and late-response races are automated checks, not claims about timing a real desktop race. |
| Copy → This event | Real report assembly and independent browser clipboard read | Independent desktop clipboard read contained one selected record. |
| Copy → This operation | Every correlated page included, unrelated records excluded | Independent desktop clipboard read contained 216 records, one trace and the final parallel sibling. |
| Copy → Current results | Matching results beyond loaded pages; size/incomplete disclosures | Independent desktop clipboard read contained all 151 operations, including the oldest synthetic operation beyond the loaded page. |
| Export → Current results / This operation | Frozen scoped selection, full matching pages and canonical report assembly | Native saved JSON contained 299 matching problem-view records across 150 traces (150 problem records and 149 failed spans), and a separate operation export contained 216 records in one trace. Both were independently read from disk and reported complete. |
| Export formats and All retained diagnostics | Real report files and sanitization; deterministic substituted destination/chooser for automated UI tests | Actual KDE picker saved JSON, HTML, ZIP and OTLP. Independent inspection found 520 records in JSON and ZIP manifest, all fixture stages in HTML, valid OTLP logs/traces, and no private images. ZIP contained HTML, JSONL, manifest, OTLP logs and OTLP traces. |
| Export cancellation and filenames | Date/time-format regression across all formats, milliseconds, unchanged cancellation result; failed destination does not report success | Native timestamped default filename observed and saved. KDE Cancel produced neutral Cancelled feedback. User-assisted JSON save and agent-operated remaining formats are distinguished; a closed picker alone was not counted as cancellation or success. |
| Copy/Export menu interaction and privacy help | Viewport placement, keyboard traversal, Escape/focus restoration, disabled invalid-result reports, all applicable scopes, disclosure wording | Menus and scoped actions exercised through native accessibility. Ordinary exports exclude private screenshots; correlation identifiers, versions and timestamps remain, so no anonymity claim is made. |
| Action notices, Details, Dismiss | Shared admission, duplicate suppression, serialized differing writes, cancellation neutrality, correlated failure enrichment; fixed footprint and reachable history | Floating notices replace the full-width bar. Multiple results did not shrink the workspace; Details exposed full destinations and prior outcomes. Native export success and cancellation were observed. |
| Debug and private capture | Consent gate; selected/next-turn scopes; durable authorization; expiry and failed-status behavior; safe image admission | Native consent, debug start/stop, next-turn capture and selected-operation capture exercised. A synthetic 68-byte PNG was stored only after UI authorization. Capture status persisted across app reopening. No real browser conversation was captured. |
| Delete private captures | Separate confirmation, committed storage oracle, expired/orphan handling | Keep records preserved the synthetic private image. Confirmed deletion removed it while preserving normal-record count. Capture was stopped. |
| Clear normal diagnostics | Separate confirmation; selection/count/list reset; active-import protection | Keep records preserved 553 disposable records. Confirmed deletion produced zero records in an independent worker read and an empty Overview. Real records were not cleared. |
| Recovery / Review setup | Correlated route requires reconstructible original workflow; unsupported evidence fails explicitly; setup approval/cancellation and cache-regeneration behavior covered | Native unsupported synthetic operation reported that original choices could not be reconstructed and started no setup changes. Real-profile conflicts are recorded below; no repair was applied. |
| Narrow layouts, languages, focus and zoom | Whole-launcher and Diagnostics fixtures, English/Chinese/Japanese, narrow/touch layouts, long content, menu reachability, timeline geometry and no search-control shift | Final rebuilt app visually inspected at 1120×720 and larger sizes. Native 144% and approximately 207% keyboard zoom exercised and restored. Shared card/heading insets and date-field width regressions are covered. |

## Final build and native input

The ordered gate passed 870 root tests and 318 launcher tests, followed by all 14 browser UI tests (328 assertions). Non-UI verification included versions, audits, type/static checks, builds and relocatable smoke checks. The packaged Linux smoke check passed. The tested `launcher/artifacts/codex-web-gpt-5.0.3-linux-x64.AppImage` has SHA-256 `78f8d901185b50f8445e7288ee786a12f9d836638802fcd90546610ad59e7a81`.

Because another desktop application captured host keyboard/pointer input, final physical-input checks used the actual AppImage on a temporary private X11 display, not a browser fixture. Task-ID input, segmented date input, reversed-range validation, disabled invalid-result copying, corrected-range recovery, regex cancellation, menu End/Escape/focus restoration and zoom passed. Independent persisted writes stayed absent while paused; Refresh and New activity each exposed the new records on demand. The temporary app and display were closed after acceptance. KDE picker and desktop clipboard evidence above came from the normal host desktop, not this private display.

## Real-profile result and remaining startup conflict

The final AppImage opened the real history in Overview, Operations and Advanced. A retained failed login operation opened its stage timeline; legacy and missing-terminal-evidence warnings remained visible. Read-only store checks found at least the original 9,520 records and the same oldest timestamp, with no private capture active. The runtime config, Codex config and source-channel descriptor matched their pre-check hashes. No real history was cleared and no model message or setup repair was submitted.

Real-profile startup is not accepted as healthy: it emitted `runtime.startup_failed` and `bridge.route_restore_after_runtime_failure_failed`. Read-only route status identified missing `experimental_realtime_webrtc_call_base_url` and an Interrupt hook differing from the installation journal. Native-protocol repair preview returned `blocked`, no changes and no approval ID. These settings were left untouched; resolving that ownership/configuration conflict is separate from the verified diagnostics controls. A supervisor reporting ready does not override the failed startup evidence. Positive fresh setup-review completion was not forced by altering configuration or downgrading the runtime.

## Platform and interaction limits

Linux native accessibility actions are AT-SPI interactions, not a screen-reader evaluation. Real screen-reader and virtual-keyboard acceptance remain unverified. Windows and macOS have fixture coverage but were not natively exercised on this Linux host. Thirty-minute capture expiry and cancellation races are checked with deterministic automated controls rather than waiting for or forcing those timings against a live user session. External generation, model output correctness, live MCP tool execution, and setup mutations are outside this no-message acceptance pass.

## Saved synthetic reports

- JSON saved through the native picker: `/tmp/codex-web-gpt-diagnostics-2026-09-06T05-00-25-460Z.json`.
- HTML: `/var/tmp/cgw-native-9fEP6g/native-all.html`.
- Support ZIP: `/var/tmp/cgw-native-9fEP6g/native-all.zip`.
- OTLP: `/var/tmp/cgw-native-9fEP6g/native-all-otlp.json`.
- Current results: `/var/tmp/cgw-native-9fEP6g/native-current-results.json`.
- Selected operation: `/var/tmp/cgw-native-9fEP6g/native-operation.json`.

These are local acceptance artifacts, not published reports. Their counts describe the frozen selection at export time, not the current store. Saved reports were independently read after the picker completed.

## Follow-up: missing-hook repair

The subsequent repair fix makes the real-profile conflict reviewable without applying it. A wholly absent Interrupt collection, recorded trust entry and managed markers can now produce an exact restoration plan from the active journal; edited, duplicated, reordered and partially removed hooks remain blocked. The missing-hook finding is attached to the managed command, avoiding an incorrect “unchanged external integration” row. Tests first reproduced both the blocked preview and misleading review grouping, then proved approved restoration, preservation of other hook events and Native choices, read-only preview, stale-approval rejection and the remaining conflict boundaries.

Final ordered verification passed 873 core tests, 318 launcher tests and all 14 browser tests (328 assertions), including the offline Codex capability probe, type checks, audits, builds and relocated smoke checks. The final packaged smoke check passed. The replacement AppImage SHA-256 is `67c5deea624194f16133b645bd465130e08b025b4a06589c8e48ab8e9a8463f8`; the earlier checksum above identifies the pre-repair acceptance build.

The replacement native AppImage opened Settings → Repair Codex connection against the real profile and produced the restoration preview with Native selected. Connection and Interrupt cleanup were shown as additions, no false external-integration row remained, and Apply stayed disabled while approval was unchecked. The runtime configuration, Codex configuration and channel descriptor remained byte-identical to their pre-check versions. Real-profile application and post-repair startup remain pending explicit approval; fixture application is not evidence of a healthy live startup.

## Follow-up: generalized owned-setting repair

Inspection, repair and review now share owned-setting definitions. The repair suite covers missing, commented-out, changed and semantically equivalent values for seven supported scalar settings across LF, CRLF and CR source forms, including BOMs, quoted keys, inline comments and equivalent numeric syntax. Hook coverage includes identified scalar repairs, commented fields and bounded fully commented managed blocks; ambiguous commands, duplicate/reordered hooks and unrelated fields remain protected. These supported scalar and block repairs supersede the earlier follow-up's blanket restriction on edited or partial hooks.

The ordered `bun run verify` gate passed, including type checks, audits, core and launcher suites, build and relocated runtime smoke checks, and all 14 browser/UI tests with 328 assertions. The focused repair suite passed 105 tests with 581 assertions. Packaging and `app:smoke` passed. The generalized-repair AppImage SHA-256 is `ad31970177b7ccf6017b00cadaf058c433df985045b9bffbb4b77e899718f99e`; previous checksums identify earlier acceptance builds.

The new native package opened the real-profile repair preview with Native selected and five expected additions under Connection and Interrupt cleanup. There was no false Other integration row. Approval remained unchecked and Apply disabled. The Codex configuration, runtime configuration and channel descriptor remained byte-identical to their pre-check versions. No live repair or generation test was performed; startup after an approved repair still needs separate verification.
