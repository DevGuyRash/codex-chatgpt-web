# Confirmed configuration repair

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

Active version 8–10 route verification and modern disconnect/removal compare owned values semantically. Quoted route keys, alignment, and comments are not ownership conflicts. Restoration edits only the owned scalar settings, preserving newer sibling fields inside structured Native V2 configuration. Historical source formatting is reused only when its parsed result agrees with the syntax-aware edit. Changed values still require review. Older journal formats retain their legacy migration checks.

During an interrupted additive journal upgrade, a matching newer recovery record can supersede an older primary record only when projecting it onto the older version preserves every existing ownership field and baseline. Different baselines remain ambiguous and are not automatically adopted.

Preview values are shown only in the requested interface. Raw repair output and approval arguments are excluded from launcher activity logs. Treat a terminal preview as private configuration data; do not paste it into public issue reports without review.
