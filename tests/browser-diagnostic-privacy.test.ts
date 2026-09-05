import { expect, test } from "bun:test";
import { browserDiagnosticFailure } from "../src/adapters/chatgpt-web/browser-worker";

test("browser diagnostic error evidence never includes arbitrary messages, causes, or error names", () => {
  const error = new Error('private-title-canary /c/private-conversation-canary <div>private-prompt-canary</div>', {
    cause: new Error("private-cause-canary"),
  });
  error.name = "private-name-canary";
  expect(browserDiagnosticFailure(error)).toEqual({ kind: "browser_operation_failed" });
  expect(browserDiagnosticFailure(new Error(`strict mode violation: ${error.message}`)))
    .toEqual({ kind: "ambiguous_locator" });
  expect(browserDiagnosticFailure(new DOMException(error.message, "AbortError")))
    .toEqual({ kind: "aborted" });
});
