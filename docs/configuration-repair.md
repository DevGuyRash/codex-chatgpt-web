# Reviewed setup and configuration repair

Setup and repair share source inspection, prepared Codex changes, approval fingerprints, and the launcher's comparison view. Production setup—including setup-backed upgrades and settings changes—shows a modal before it stops the runtime or applies configuration. The view includes current/proposed settings, source line numbers, expandable exact Codex file changes, and the runtime/browser/tunnel actions that setup will perform. Credential values are not included in the runtime summary. Browser-derived capabilities and generated runtime credentials are resolved during the listed setup actions, not presented as predetermined file bytes.

Changing the protocol refreshes the comparison inside the same open dialog and clears approval. During refresh, the comparison is marked as updating, approval and further protocol changes are disabled, and Cancel/Escape remain available. A late refresh cannot reopen a cancelled review. Cancel, Escape, an expired preview, or changed inputs does not authorize setup. Setup rechecks the approval before stopping its current runtime owner and again before beginning its changes. The setup CLI prints the same structured preview and asks interactive users to approve; noninteractive callers must pass the ID from `setup --preview-json` using `--approve-configuration ID` with the same setup options. The unofficial-automation acknowledgement is separate; include `--acknowledge-unofficial` when previewing a new installation. The isolated DEV harness does not modify normal Codex configuration and does not use this production review.

For an active version 10 installation, setup and repair share a pure owned-configuration preparer. Scalar differences, including tracked commented-out routes and an enabled Native V2 setting, can produce a reviewable plan instead of stopping at the old installed expectation. Native preserves newer feature choices; Compatibility V1 proposes its required values. Hook, source-structure, and ownership conflicts still block changes. Each finding remains separate, and non-setting failures are not rendered as fictitious “not set / unchanged” table rows.

## Diagnostic recovery

The launcher backend owns the recovery-action policy used by both operation failures and Doctor checks. Structured configuration conflicts offer **Review configuration repair**; a missing route offers **Review setup**. Unknown failures offer **Run Doctor** and **Export diagnostic logs**, not a guessed destructive fix or automatic retry. The renderer only translates allowlisted action identifiers into the existing diagnostic, setup-review, repair-review, and sanitized log-export interfaces. Opening a review is not approval to apply it.

Doctor reads Codex ownership evidence without healing journal files and shows individual configuration findings or the check's diagnostic detail. Notifications expose the same recovery actions and findings; activity messages and diagnostic details wrap rather than truncating to one line. The recovery panel is available during onboarding as well as in the main launcher, and the embedded browser is hidden while a review is open.

Launcher-controlled CLI failures can carry a versioned structured error envelope. Configuration error codes and source findings survive the child-process boundary; unknown or malformed codes receive only diagnostic fallback actions. Source findings and private preview payloads are excluded from activity logs. Ordinary terminal errors retain readable text output. Recovery remains limited by the evidence available: ambiguous ownership needs inspection, and an unknown failure is not proof that setup or repair will solve it.

## Tracked source sections

The version 2 review groups settings into Connection, Subagent behavior, Interrupt cleanup, and Model catalog, with separate current/proposed values, inherited settings, all discoverable source occurrences, and installation history. Invalid same-layer duplicates have no assumed effective winner. Selecting an active or commented candidate preserves competing text as comments and regenerates the preview without closing it or retaining approval. Bounded duplicate tables and complete root-level route sections offer explicit consolidation; only route assignments move between route sections, never arbitrary contents. Legitimate arrays of hooks are not deduplicated. Incomplete syntax and uncertain ownership remain blocking source findings. The dialog initially focuses its heading, restores focus to its opener, and keeps the embedded native browser hidden through asynchronous refresh.

For independent CLI targets, capability checks, profile-local catalogs, and reviewed base restoration, see [Integration profiles](integration-profiles.md).

Source inspection distinguishes active, commented-out (inactive), and absent assignments using TOML parsing and actual table scope. Fake assignments or markers inside strings are not configuration. A unique commented scalar inside a tracked section can be reactivated by an approved edit; competing commented candidates require review. Unrelated comments are not ownership evidence.

New and updated route sections use `# BEGIN codex-chatgpt-web: routes` and `# END codex-chatgpt-web: routes`. A single historical route header is supported for migration. Duplicate/nested sections, unmatched or missing end markers, root routes assigned outside a bounded section, duplicate TOML definitions, and route markers inside or across a table boundary prevent automatic changes—even when route replacement was requested. The preview identifies the affected lines. Resolve the ambiguous source, then request another preview; the application never guesses which duplicate block owns the configuration or treats the rest of a file as owned because an end marker is absent.

Markers organize source; the installation journal remains the ownership authority. Creating a bounded section moves only the two root route assignments, not arbitrary content between markers. The Interrupt hook retains its separate bounded section. Disconnect, reconnect, repair, and setup share the same route layout support.

## Repair

In the production launcher's Settings, **Repair Codex connection** inspects configuration without changing it. Choose a subagent protocol explicitly, preview the current and proposed values, and approve that preview before applying it. Changing the protocol or encountering an apply failure discards the approval. DEV profiles do not own the normal Codex integration and cannot repair it.

Compatibility V1 requires the bridge's compatibility feature values, including disabling Native V2. Native relinquishes compatibility settings that still match bridge-owned values, restoring their recorded prior values; it preserves newer user choices. Repair does not remove `context_management`, select a model, or send a browser message.

The launcher rechecks the preview before asking its existing supervisor to stop the runtime through its idle-drain protocol. Busy or unverifiable ownership prevents application. Repair does not force-kill processes or automatically restart the runtime. After a successful repair, restart Codex and the launcher. A failed repair requires a fresh preview rather than an automatic setup-and-restore loop.

## Terminal interface

For externally owned runtimes, stop the runtime through its normal owner first. Preview and approval are separate commands:

```sh
bun run src/cli.ts route repair preview --subagent-protocol native
bun run src/cli.ts route repair apply --subagent-protocol native --approve <approvalId-from-preview>
```

Use `compatibility-v1` instead of `native` only when that is the intended protocol. Launcher-owned configurations must be applied through Settings; an ordinary terminal invocation cannot acquire launcher authority. Preview remains available from the terminal. Apply refuses a loaded managed service or a listening runtime endpoint. A closed endpoint alone is not evidence that every external process has settled; stopping through its owner remains necessary.

## Ownership and concurrency

Repair requires an active version 10 installation journal. Missing, corrupt, ambiguous, or older ownership evidence is reported as needing attention, not silently adopted. Hook identity, ordering, and trust conflicts also block automatic repair. All discovered configuration conflicts are shown together; formatting alone is not a semantic value conflict.

The approval identifies exact configuration, journal, recovery, runtime configuration, and model-cache inputs. Any intervening change requires another preview. Application revalidates those inputs, writes the configuration and ownership records using existing atomic replacement, invalidates the model cache, and verifies the resulting settings. Failure compensation restores only outputs still matching this transaction's own writes, preserving intervening edits. This is not an operating-system compare-and-swap guarantee or a promise of crash-proof multi-file atomicity.

Installation and preflight use the same prepared change plan; preflight does not heal journal files or stop after checking only the currently installed protocol. Installation, protocol switching, connection changes, and removal revalidate their observed inputs before writing. Protocol switching includes runtime configuration in the same guarded compensation operation and preserves unrelated settings from the current file, not from a caller's cached configuration. Removal verifies the journal's configuration target before changing any file. Interrupted multi-file writes still require ownership inspection; these guards do not make separate files one crash-atomic database transaction.

Active version 8–10 route verification and modern disconnect/removal compare owned values semantically. Quoted route keys, alignment, and comments are not ownership conflicts. Restoration edits only the owned scalar settings, preserving newer sibling fields inside structured Native V2 configuration. Historical source formatting is reused only when its parsed result agrees with the syntax-aware edit. Changed values still require review. Older journal formats retain their legacy migration checks.

Compatibility V1 setup and approved repair share feature acquisition: ordinary tables, quoted or dotted keys, nested inline tables, and equivalent positive integer representations describe the same settings. The baseline records only owned scalar values; unrelated feature fields are not restored from an old snapshot. When the historical renderer cannot represent the current syntax, installation uses the syntax-aware edit and a canonical scalar baseline instead of adding competing assignments.

During an interrupted additive journal upgrade, a matching newer recovery record can supersede an older primary record only when projecting it onto the older version preserves every existing ownership field and baseline. Different baselines remain ambiguous and are not automatically adopted.

Preview values are shown only in the requested interface. Raw repair output and approval arguments are excluded from launcher activity logs. Treat a terminal preview as private configuration data; do not paste it into public issue reports without review.

The launcher does not restore a pre-setup snapshot over files that changed during setup: it cannot prove whether those bytes belong to setup or another writer. The CLI's guarded configuration transaction owns its own compensation. If changed files remain after setup failure, the launcher reports that they need review and does not restart a previous runtime using an unproved configuration.
