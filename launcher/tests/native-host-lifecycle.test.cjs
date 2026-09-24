const test = require("node:test");
const assert = require("node:assert/strict");
const { createNativeHostLifecycle } = require("../electron/native-host-lifecycle.cjs");

test("native host diagnostics retain transitions without logging repeated success traffic or message content", () => {
  const events = [];
  const id = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
  const connectionId = "11111111-1111-4111-8111-111111111111";
  const lifecycle = createNativeHostLifecycle({
    providerIds: new Set([id]),
    logger: {
      info: (name, attributes) => events.push({ severity: "info", name, attributes }),
      warn: (name, attributes) => events.push({ severity: "warn", name, attributes }),
    },
  });
  lifecycle.observe({ extensionId: id, connectionId, phase: "started" });
  for (let index = 0; index < 1000; index += 1) {
    lifecycle.observe({ extensionId: id, connectionId, phase: "response", responseClass: "success", content: "must not be retained" });
  }
  lifecycle.observe({ extensionId: id, connectionId, phase: "response", responseClass: "browser-verification-failed", verificationReason: "signature-invalid" });
  lifecycle.observe({ extensionId: id, connectionId, phase: "exit", exitCode: 1 });

  assert.equal(lifecycle.activeCount(), 0);
  assert.deepEqual(events.map(event => [event.severity, event.attributes.phase, event.attributes.classification]), [
    ["info", "started", undefined],
    ["info", "response", "success"],
    ["warn", "response", "browser-verification-failed"],
    ["warn", "exit", undefined],
  ]);
  assert.equal(JSON.stringify(events).includes("must not be retained"), false);
  lifecycle.destroy();
});
