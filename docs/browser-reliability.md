# Browser identity and safe launcher transitions

Connector lookup is scoped to connector-owned rows, not every menu-shaped element in the page. The visible exact-name candidate must be unique before keyboard activation, and the selected composer pill must independently confirm the requested connector. A sidebar conversation with the same name is not a connector candidate. A strictness race is a non-retryable identity failure, not a reason to repeat browser preparation.

The offline selector contract runs with `CHATGPT_TEST_CHROME_EXECUTABLE` pointing to an installed Chromium executable: `bun test tests/connector-menu-dom.test.ts`. It launches a fresh, unauthenticated browser, blocks page network requests, and renders synthetic HTML. Without an explicit executable the browser test is skipped; ordinary worker and reconnect tests still run. This fixture proves locator behavior, not current ChatGPT service compatibility.

The authenticated loopback control endpoint `POST /v1/launcher/shutdown-idle` accepts an empty JSON object. It refuses overlapping shutdown and new browser admissions while draining. It uses the runtime supervisor's non-cancelling, non-forcing shutdown path, persists the session, and acknowledges before closing the control connection. A successful acknowledgement must be followed by observed process exit before another launcher uses the profile. Busy/refused shutdown returns HTTP 409. Launchers predating the endpoint return 404; callers must not silently substitute process termination.

Normal user-initiated Quit retains its existing cancellation behavior. Idle shutdown is a separate contract for supervised development and channel transitions, not a change to what Quit means.

Persisted browser capture errors contain only structural categories, not arbitrary exception names, messages, or causes. Launcher logs and legacy exports omit recognized browser exception/DOM dumps as whole strings because partial redaction cannot reliably remove private rendered content. Screenshots remain explicit opt-in private evidence; diagnostic files and recovery snapshots should never be uploaded without review.
