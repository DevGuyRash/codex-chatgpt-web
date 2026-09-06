# Local diagnostics

Diagnostics connects launcher actions, setup stages, runtime requests, and browser operations through OpenTelemetry trace and span identities. It is local-first: no monitoring server, network-accessible diagnostics endpoint, or remote exporter is required. Diagnostics records provide evidence and allowlisted links to existing recovery workflows; they do not authorize setup changes or retries.

## Architecture and build

The authored implementation is strict TypeScript. Shared Zod contracts in `src/diagnostics/contracts.ts` validate records, queries, capture commands, problem envelopes, and worker messages. The root compiler targets Bun; the renderer and Electron diagnostics compiler configurations are separate. `scripts/build-diagnostics.ts` emits the CommonJS host adapter and preload consumed by Electron. Generated JavaScript is not a second implementation.

`Diagnostics` uses explicit OpenTelemetry tracing and logging providers with local exporters, without registering a remote/global SDK. Producers preserve supplied task identifiers and names, but do not scrape conversation titles or derive names from prompts. Command results remain on stdout; launcher-owned child diagnostics travel on a separate inherited pipe. Standalone processes use the same bundled Bun worker implementation.

SQLite work runs outside the Electron renderer/UI thread. A separate query worker executes searches with a two-second limit and is terminated and joined on cancellation or timeout. WAL, FTS5, indexed filters, and sequence-based cursors support concurrent writers and paginated read-only access. Follow cursors advance by ingestion sequence rather than producer clocks, so late-arriving events are not silently skipped.

Retained legacy logs import in the background after worker readiness, in batches of at most 128 records with an event-loop yield between batches. Deterministic record identities make interruption/resumption idempotent; storage failures do not mark a file complete. Unfinished imports remain visible to read-only queries across restart. Shutdown cancels and joins the importer, and clearing normal records is refused during an active import so backfill cannot immediately repopulate a cleared store. Routine WAL flushing uses SQLite's configured automatic checkpoint threshold; explicit reclamation runs when the complete database/WAL budget requires it. The original log files are not changed by import.

Schema version 2 keeps sanitized events authoritative. The span projection selects terminal evidence over delayed starts. Trace membership counts, problem codes/recovery state, and operation-duration metric samples are maintained transactionally and removed with their underlying events. Opening a version-1 store with the writer adds these projections without replacing its records. Unsupported schema versions fail closed; read-only access does not upgrade a database.

Stores live beneath the selected application's data directory at `diagnostics/observability/diagnostics.sqlite`; development and production use their existing separate data roots. Target/profile identity remains attached to records and available as a filter. Paths, subprocess invocation, export replacement, and Electron dialogs are isolated from presentation components. Runtime bundles carry Bun and the query worker; diagnostics does not require a system Bun, Bash, Unix socket, or external database.

## User workflow

Overview shows recent problems/interrupted operations, a read-only runtime health observation, and separate collection status. Operations presents named operations and an expandable correlated stage timeline. Advanced provides event filters, full-text/regex search, paging, technical details, and pause/resume controls. Capture & storage contains debug/private controls, retention, storage usage, deletion, and sanitized export. Notifications can open an operation by trace ID.

The workspace and capture indicator share one diagnostics controller. Health/capture observation continues while automatic list updates are paused. Foreground search is debounced by 180 ms and exposes its reserved progress/cancellation control only after 300 ms; background refresh never uses that control. Each request has an independently cancellable renderer-owned identity. Superseded responses cannot replace newer results. Selection, expanded groups, and older-scroll inspection hold automatic list replacement and expose a New activity action instead.

Overview groups operation occurrences, not propagated error records. The first chronologically recorded problem represents an occurrence; this is a presentation rule, not an inference that it is the ultimate cause. Its code, stage, component, target, and runtime version identify a repeated signature. Ambiguous generic failures remain separate unless their application-owned message identifies a known producer. Occurrences are newest-first, while correlated stages are oldest-first. Advanced and operation reports preserve every retained raw record. Historical cancellation/error contradictions are explained without rewriting evidence or inventing a cancellation reason.

Launcher action feedback has an explicit policy for every API member: navigation, subscriptions, and ordinary state reads stay quiet; work-producing controls share admission, pending state, and completion feedback. Consecutive identical pending requests share one execution; differing requests to one launcher API method execute in order. Group and timeline work have separate admission scopes. Feedback shows a compact latest-result notification in the lower-right corner without a full-width bar or shrinking the workspace. Details opens the retained notices and recovery actions on demand; Escape restores focus to its trigger, and an outside click closes the details. Dialog feedback stays inside its dialog. Operation events enrich the corresponding API-owned notice rather than making an intermediate stage look like completion. Accepted launches/updates are distinct from verified completion. Explicit cancellation is neutral; a genuine recorded failure preceding cancellation remains a failure. Setup review cancellation does not emit an unexpected-error problem.

Embedded browser views retained offscreen must follow the current native window geometry while Diagnostics or another launcher surface is active. The host coalesces resize placement after native bounds settle, because Electron/X11 can emit a resize event before reporting the new content size. Pending placement work is cancelled when the browser host is destroyed; no renderer-mounted browser slot is required for this update.

Treat outcomes literally: a recorded failure is not proof that rollback failed, and missing terminal evidence is not success. Running is a last-observed state, not a process-liveness assertion; queries disclose stages without terminal records. An observed abnormal child exit records interruption for its unfinished stages, while a clean exit without completion evidence records an unknown outcome. A whole-launcher crash may leave only the original start evidence. Structured problems preserve stage, findings, causes, correlation, and observed recovery state. Stale setup previews require a fresh review; refreshing a preview invalidates its previous checkbox approval. Existing setup workflows continue to own exact-preview approval and configuration changes.

## CLI and agent interface

Use the installed runtime command, followed by any existing global target-selection options and `diagnostics`. For source development, the equivalent prefix is `bun run src/cli.ts`. Examples below use `codex-chatgpt-web` as the installed command name.

```text
codex-chatgpt-web diagnostics status --json
codex-chatgpt-web diagnostics list --view operations --limit 100 --json
codex-chatgpt-web diagnostics show TRACE_ID --json
codex-chatgpt-web diagnostics search "preflight" --component launcher --json
codex-chatgpt-web diagnostics search --regex "preview|recovery" --json
codex-chatgpt-web diagnostics follow --trace TRACE_ID --json
codex-chatgpt-web diagnostics export --output report.zip --format bundle
```

`status`, `list`, `show`, and `search` are read-only and work with the launcher closed. They do not start the bridge or apply configuration. `show` requires a valid trace identity. `follow` polls until interrupted; its output is newline-delimited versioned query results. Ordinary JSON query responses contain `version`, `events`, `incomplete`, `notices`, and optional cursors. Reuse a page cursor with the same filters. Filters include target, component, severity, task, trace, and time bounds; `diagnostics help` is the argument reference. Collection unavailability is represented explicitly in `status --json`, not as a healthy empty store.

Agents and users retrieve the same retained records. Inspect notices and completeness before drawing conclusions. A diagnostic problem can suggest review or Doctor, but execution still needs the authority of the originating workflow. Export is an explicit local write to the chosen path, not a transmission. Clearing and capture activation are separate confirmed controls, not side effects of reading evidence.

## Bounds, privacy, and portable reports

Normal retention is 14 days or 64 MiB, counting the SQLite database, indexes, WAL, and shared-memory file. Expired records are pruned when a writer opens and during maintenance. Retention removals are disclosed separately from collection drops. Read-only queries exclude expired evidence without mutating storage. A paused or closed application cannot perform physical cleanup until its writer runs again.

Producer event queues and outstanding request bytes each have a 4 MiB budget. Records are capped at 12 KiB after sanitization; batching is limited to 128 records, pages to 200, and worker requests to 2 MiB. Failures and span lifecycle records take priority over repetitive lower-priority events. Initial status/control requests allow ten seconds for cold worker/store startup; subsequent status/control requests allow two seconds. Unresponsive workers are retired rather than accumulating more pending data. Worker termination closes the input stream even if its parent leaves the pipe open. Collection failures are reported without changing the task's result.

Debug activation lasts 30 minutes and captures additional structural evidence only. Normal/debug records exclude prompts, responses, credentials, raw browser DOM, and screenshots. A private browser-capture session requires explicit acknowledgement and an operation scope, lasts at most 30 minutes, and has a persistent launcher indicator. A next-turn scope is claimed by exactly one trace. Authentication/settings/embedded-frame surfaces are excluded by a conservative browser gate, which is checked again after capture. Each accepted PNG is at most 1 MiB and is stored separately with owner-only creation permissions on POSIX. Private files expire after 24 hours and have a separate 128 MiB budget; cleanup runs on worker opening and maintenance. Stopping a session revokes further admission, but deletion is a separate control.

Independent producers refresh capture/debug controls every five seconds; inactive checkpoints do not wait for a status query. An active capture rechecks its scope before taking an image and again on persistence, so a stale local activation cannot authorize storage. Additional visible input controls are excluded even when their HTML type is generic. The private store admits at most 1,024 files, reports missing/expired files, and confirmed deletion removes owned UUID-named orphan images without deleting unrelated files.

Ordinary copy/export excludes private files, local task names, identifying home paths, and sensitive attributes. Export formats are JSON, self-contained HTML, a ZIP support bundle, and OTLP JSON. The bundle contains the HTML report, sanitized JSONL records, component versions/collection health in a manifest, and standard OTLP trace/log documents. HTML has no external assets or scripts, escapes record content, and remains usable without Electron. Exports are capped at 20,000 records or approximately 32 MiB of record JSON; the report discloses an incomplete selection. Destinations cannot alias the store/private directory, and replacing an export does not alter permissions on its parent directory.

Copy and Export menus expose the applicable event, operation, and current-results scopes; all retained diagnostics is an explicit export scope. Copy supports a readable summary or JSON and is bounded to 1,000 records or 256 KiB of compact record JSON before formatting. Both paths use the same worker-owned report assembly and sanitization. Results cover all matching pages, not just the loaded page. A sequence boundary freezes selection before the export chooser opens. Returned metadata identifies record count, incomplete evidence, and the saved destination; chooser cancellation is not success. Correlation identifiers, timestamps, and component versions remain, so these reports are not anonymous.

The native save dialog suggests a sortable UTC timestamp, for example `codex-web-gpt-diagnostics-2026-09-06T04-52-31-247Z.json`. The `T` separates date and time; colons and the fractional-second separator become hyphens for cross-platform filenames. Milliseconds distinguish nearby exports, but are not a global uniqueness guarantee. The user still chooses the destination and confirms replacement through the native dialog.

## Verification and platform coverage

The [September 6 control-by-control acceptance record](diagnostics-acceptance.md) covers the final alignment/feedback build, ordered automated gate, native picker/clipboard/input evidence, and the unresolved real-profile startup conflict. Its newer native keyboard/zoom evidence supersedes the corresponding earlier gaps below.

Use local `just ci`; hosted CI remains disabled for this fork. It includes source checks, emitted Electron-adapter tests, renderer build/tests, and the relocatable-runtime smoke check. The latter runs the packaged executable and query-worker artifact from a moved directory, independently retrieves its evidence through the packaged CLI after closing the writer, and exports to a Unicode/spaced path. These checks do not send model messages or change live setup.

The aggregate verification runner enforces all non-UI checks before browser tests. `bun run verify:non-ui` runs Gate A only; `bun run test:ui` is the explicit browser suite and fails when its Chromium prerequisite is missing. Native computer-use acceptance follows both automated gates on a rebuilt AppImage. The packaged smoke check also verifies that failure codes survive the real IPC/contextBridge boundary as plain data; the renderer then recreates typed errors and localized feedback. Earlier platform evidence below describes its recorded build and does not substitute for acceptance of subsequent changes.

| Surface | Evidence available | Not established by that evidence |
| --- | --- | --- |
| Linux x64, bundled Bun 1.4.0 / Electron 41.10.7 | Actual AppImage launch in isolated Xvfb, renderer/preload/host/worker IPC retrieval, correlated failures, SQLite/FTS/regex, export; real Electron 200% page zoom with diagnostics capture/storage navigation, focused control reachability and no page horizontal overflow; relocated CLI and POSIX permissions | User-driven zoom shortcuts, real virtual-keyboard behavior and screen-reader acceptance |
| Windows | Drive, UNC, case, separator and replacement fixtures | Native packaged execution, filesystem permissions/locks, every shipped architecture |
| macOS | Shared implementation and platform-neutral contracts | Native packaged execution, signing/sandbox behavior, every shipped architecture |
| Chromium renderer fixtures | Whole-launcher 320/640 widths and reduced-height viewport; diagnostics 1280 width; touch/high-DPI, reduced motion, English/Chinese/Japanese, keyboard-safe deletion, persistent capture indicator, 1,000-record virtualized navigation | Actual native 200% zoom, real virtual-keyboard behavior, assistive-technology acceptance, native mobile apps |

Live Linux acceptance on September 5, 2026 reproduced two separate setup failures: the tunnel subprocess selected a broken PATH Bun wrapper instead of the running bundled Bun, and background regeneration of the disposable Codex model cache invalidated an otherwise unchanged setup approval. Runtime selection now prefers a durable running Bun after explicit overrides, and install approval binds configuration/ownership inputs rather than generated model-cache contents. Cache removal remains covered by commit-time compensation. Regression tests cover both causes.

After rebuilding and relaunching the real AppImage, the reviewed Native setup completed in trace `c13c3674650fd9efebfa678f53369818`: browser capability inspection, tunnel readiness, setup application, and runtime upgrade succeeded. Codex subsequently retrieved the model catalog, and the real Diagnostics screen reported runtime health and local collection available. This acceptance did not submit model messages, change the source-channel configuration, or establish generation correctness. See `context/state.md` for unfinished recovery and accessibility acceptance.

The native zoom check uses a disposable, English-language workspace fixture after startup, leaving onboarding and external links outside its claim. Linux smoke execution explicitly selects X11 under Xvfb, independent of the host's Wayland preference. The check changes Electron's page zoom rather than emulating device pixel density; it restores the original zoom afterwards. It does not activate debug or private capture.

## Reproducible storage measurements

Run `bun run scripts/benchmark-diagnostics.ts` with the pinned runtime. It uses synthetic data in disposable stores, one closed-loop writer with batches of 128, thirty warm indexed queries per dataset, and one fresh-worker query per dataset. Generation time is excluded from ingestion time. Its output distinguishes offered, accepted, retained, retention-removed, and dropped records, and includes storage bytes and sampled peak writer RSS. This is a storage measurement, not an Electron responsiveness or open-loop saturation claim.

On Linux x64 / AMD Ryzen 9 3900X / Bun 1.4.0, the September 5, 2026 run after retention reporting produced:

| Dataset | Accepted / offered | Retained | Stored bytes | Ingestion records/s | Warm query p95 | Fresh-worker query | Sampled peak writer RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default 64 MiB budget | 30,000 / 30,000 | 27,952 | 66,081,888 | 9,346 | 3.76 ms | 83.82 ms | 105,324,544 bytes |
| Larger 256 MiB budget | 60,000 / 60,000 | 60,000 | 140,750,848 | 14,702 | 2.30 ms | 115.88 ms | 125,239,296 bytes |

The default-budget run removed 2,048 records through retention and reported that fact; neither run reported collection drops. These are descriptive measurements from one machine, not performance guarantees or evidence for untested platforms.

The Chromium renderer fixture loads 1,000 synthetic records while mounting at most twelve list rows. Ten Playwright End-to-last-record-focus samples measured 5.02–10.73 ms, with 11,372,904 bytes of JavaScript heap reported by Chromium. The renderer is real, but its API is synthetic; these measurements include test-driver overhead and are not physical input-latency or whole-process memory guarantees. The whole-launcher fixture separately connects the real emitted host, worker, SQLite and CLI through a test-only substitute for Electron IPC. A UI-visible synthetic failure is independently retrieved through the CLI; this is not a reproduction of the user's original approval failure.
