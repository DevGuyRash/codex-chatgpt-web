# DEV chat harness

For installation, launch modes, normal/DEV coexistence, and ChatGPT connector creation, start with [development launcher setup](dev-setup.md).

The repository DEV chat exercises current source code without routing the native Codex app through
that working tree. It is intended for browser, MCP, tool-round, retry, and compaction development
while the normal launcher, its ChatGPT account, and the maintainer's active Codex session remain
usable.

## Prerequisites

- Use the repository-pinned Bun version.
- Build the WebAuthn-enabled Electron runtime in [native/electron](../native/electron/README.md) and select its packaged launcher; source `bun run dev` also requires that reviewed binary.
- Install a launcher built from the same working tree.
- Start the isolated launcher with `CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=/absolute/path/to/reviewed/launcher bun run dev:launcher`; later calls without the override reuse the running DEV owner. See [development launcher setup](dev-setup.md) for each platform's executable path.
- It skips the normal marketing onboarding and opens the setup surface directly. Sign in inside the
  window labelled **DEV**. This may be a different ChatGPT account.
- Run its browser smoke test and initialize the DEV profile. Complete MCP setup only when testing simulated tool rounds; browser, effort, context-limit, and compaction work in browser-only mode. The launcher stores any MCP credentials only in the DEV home and supervises only that isolated tunnel. Full mode requires a Chat-compatible connector named `Codex Native2 DEV`; verify availability from ordinary Chat because current personal plugin creation may route to ChatGPT Work. Keep `Codex Native2` unchanged.

Nothing is copied from the normal launcher. The DEV command fails closed if its own launcher,
browser descriptor, credentials, or connector are not ready. It never falls back to the production
profile, another model, a fake browser, or a second connector.

## Run

One browser-only message:

```bash
CODEX_WEB_GPT_LAUNCHER_EXECUTABLE=/absolute/path/to/reviewed/launcher bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat smoke "Reply with exactly: DEV READY"
```

Persistent interactive chat:

```bash
bun run dev:chat compaction-lab
```

After optional Full/MCP setup, the same command also exposes simulated outer tools:

```bash
bun run dev:chat tool-lab "Use a command tool and explain the simulated receipt"
```

The direct DEV tool `mcp__dev_simulator__large_context_payload` accepts the explicit arguments
`segment` (1, 2, or 3) and `target_tokens` (1,000 to 95,000). It returns deterministic, coherent,
inert prose through the real simulated MCP-result path so a live named chat can exercise retention
and automatic compaction without embedding a giant fixture in the user prompt. It is advertised
directly rather than through deferred tool search so the test can prove the requested call happened.

Reusing the same name continues its canonical Responses history. Sequential native messages in the
same compaction epoch lease one Temporary Chat, exactly like production. Every message receives a
new turn-bound MCP token, and all MCP tool rounds for that message remain inside the same ChatGPT
response. On an exact native compaction request, the same Web agent submits the checkpoint through
a one-shot MCP control call in that chat; only then does the surface close and the next epoch open a
new Temporary Chat. The complete named history remains owned by the existing prompt compiler. New
chats use the cheapest account-supported browser mode:
Instant (`light`) when Sol is available, otherwise Luna. Override it with `--model` or `/model`.

SIGINT or SIGTERM during a DEV message aborts its active Responses request, allowing the browser helper and broker to settle before the CLI exits. An interrupted message is not committed to the named chat history, and an uncertain external effect is never replayed automatically.

When ChatGPT reports **Too many requests** before any inline or multipart Send is activated, the browser returns a typed `rate_limit_before_send` cause. The DEV chat saves that exact unsent message and selected model in its private named-chat file without adding it to completed history. Stop sending requests while the account is limited. After capacity returns, run `bun run dev:chat NAME --retry-pending` or open the named chat and enter `/retry`; that retry is explicit and uses the same message and model. `/pending` shows only its state and timestamp, and `/discard yes` removes it without changing completed history. A retry is marked uncertain before it contacts ChatGPT; if it is interrupted or fails after submission might have occurred, another automatic or `/retry` replay is blocked until the user inspects the ChatGPT turn and discards or reconciles the pending record. No cooldown duration is guessed from the generic dialog.

In a native Codex task, the same pre-Send cause is reported with a recovery instruction instead of starting another browser attempt. After account capacity returns, send a new instruction in that same task asking Codex to retry the previous unsent request. The task history supplies the prior request when it is still present; if compaction or history loss removed it, provide the request again. A rate limit after Send has a different outcome and must be inspected in the ChatGPT tab before any replay.

Interactive commands:

```text
/status
/pending
/retry
/discard yes
/fill 30000
/send-fill 12000
/compact
/model high
/reset yes
/help
/exit
```

`/fill N` appends deterministic inert text measured by the production tokenizer. It does not open
ChatGPT. The next message checks the real model-specific auto-compaction threshold and calls the
same `compactRequest` handler when the threshold is crossed. `/compact` forces that handler
immediately. Luna keeps its production rolling-checkpoint contract and therefore rejects the
separate compact command.

`/send-fill N` sends deterministic inert text as the current message through the live browser. Use
it to exercise the one-message composer budget and multi-chunk prompt insertion independently of
history growth. The normal model-specific browser preflight still applies and fails closed above
the measured transport limit.

## Bigger Context experiment

Both launcher profiles expose **Bigger Context (experimental)** in Settings. It is disabled by
default. The switch updates the profile's canonical runtime configuration through the normal setup
transaction; it is not a launcher-only preference. Production setup also rewrites the managed
Codex model catalog with 3x context and auto-compaction thresholds and asks you to restart Codex.
The DEV CLI reads the same setting from its isolated runtime configuration on each command.

When enabled, a normal turn stays on the original single-message path while its estimated input is below the selected mode's existing auto-compaction threshold. It uses two parts when that fits the complete records and measured message limits, or six when more parts are needed. Compaction uses six parts. The final context part also commits the transaction and starts the task, so there is no extra request. The existing DEV compaction threshold remains three times the selected mode's base limit.

Each stage contains complete semantic records, never a raw JSON string cut in the middle. The model must return an exact transaction-bound SHA-256 acknowledgement before the next part is sent. Images, the MCP connector, and the private `turn_token` are attached only to the final part. In Full/MCP mode, compaction does not replay the expanded history into an unrelated summarizer. If the source Web response is still waiting on a tool boundary, its canonical tool results finish that response first without a compaction suffix. If those results are enough for an ordinary final answer, that committed answer remains owned by the logical Responses turn across the physical chat retirement. If the Web model instead requests another tool, the broker blocks that new execution and tells the response to stop; the compacted continuation then resumes the unfinished work. The exact retained chat receives one strict checkpoint message with only the one-shot MCP control capability and no ordinary work capability. The checkpoint never rides in the tail of a potentially huge tool result, and its wait is capped at five minutes independently of the normal turn timeout. After the structured handoff is accepted, the bridge explicitly ends that one-purpose browser turn and waits for its physical launcher settlement before closing the old surface; the next epoch then starts a fresh Temporary Chat. This does not depend on ChatGPT rendering assistant text or a Copy action after the control-only response. If the retained private chat was already closed, the bridge starts one read-only fallback chat from the canonical Codex history instead. Browser-only mode has no retained MCP boundary and keeps the six-part compaction path so its summarizer receives the complete expanded history.

Any missing or malformed acknowledgement fails the whole transaction. No later part or final commit is sent, and a retry starts again from part one in a fresh Temporary Chat. The model context and auto-compaction ceilings are reported as 3× while the switch is active, but every individual stage must still fit the selected ChatGPT mode's measured one-message boundary.

Small turns add no staging requests. A two-part transaction sends one inert stage and one final commit; a six-part transaction sends five inert stages and one final commit. Each submission has a transaction-bound acknowledgement. Browser-only compaction uses the six-part path. These extra browser requests can increase rate limits or temporary cooldowns. The experiment remains unavailable for Luna because its later requests still include the accumulated transcript inside the same measured 28,000-token browser transport budget.

Browser-only chats do not advertise outer tools and never claim simulated effects. Full setup keeps
the launcher-owned DEV tunnel ready so ChatGPT can create and validate `Codex Native2 DEV` before a
CLI chat starts. Each named chat attaches its broker to that tunnel, while every dispatched action
still returns an explicit simulation receipt.

The default isolated home is:

```text
~/.codex-chatgpt-web-dev/
├── config.json
├── codex-home/
├── launcher/                 # Electron userData, cookies, login, logs, window state
├── chats/<name>.json
├── runtime/
└── tunnel/
```

Set `CODEX_WEB_GPT_DEV_HOME` to choose another absolute DEV home. Generic `--home`,
`CODEX_CHATGPT_WEB_HOME`, `CODEX_HOME`, and `CODEX_WEB_GPT_LAUNCHER_DATA_DIR` never collapse the DEV
launcher into production storage.

## Isolation contract

The DEV driver:

- requires a descriptor explicitly marked `development` and a config explicitly marked
  `dev-harness`;
- uses a separate Electron `userData` directory and a separate persistent browser partition, so
  cookies, OAuth state, local storage, account selection, and launcher state cannot cross profiles;
- uses an isolated sandbox `CODEX_HOME` but never writes a Codex route into it;
- does not call setup, route connect/disconnect, service start/stop, or uninstall;
- does not start `Bun.serve` or bind the configured Responses port;
- rejects any attempt to start the Responses server from a `dev-harness` config;
- does not edit the normal `~/.codex/config.toml` or integration journal;
- leases an isolated DEV-launcher browser tab and runs the working-tree browser helper;
- owns the private DEV broker socket only for the command's lifetime;
- reuses the isolated tunnel supervised by the DEV launcher and never starts a competing alias;
- can run beside the production launcher, Responses port, and tunnel because none of their homes,
  browser partitions, descriptors, broker sockets, profiles, or aliases are shared;
- refuses to run Full-mode tool rounds until the launcher-owned DEV tunnel is ready;
- exposes ordinary structural tools, then returns a universal receipt containing
  `simulated: true` and `side_effects_performed: false` for every dispatched action.

The simulator has no keyword-to-result table and never claims that a command, patch, image read,
user interaction, or external mutation actually happened.

Full-mode tools carry a one-turn `turn_token` in the connector's declared field. The token is a local authorization handle, not task data: it must never appear in shell commands, files, URLs, or the final answer. The bridge now states that boundary explicitly in its ChatGPT transport prompt. ChatGPT may still reject a proposed tool call before it reaches the local broker, including when a command carries opaque synthetic identifiers whose purpose is unclear. A model's statement that it was blocked is not itself a local tool receipt. Retain the exact UI and diagnostic evidence, keep the turn's effects unconfirmed, and explain legitimate fixture identifiers in task instructions rather than concealing them or resubmitting the same blocked action.
