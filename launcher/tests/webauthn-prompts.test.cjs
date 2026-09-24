const test = require("node:test");
const assert = require("node:assert/strict");
const { WebAuthnPrompts } = require("../electron/webauthn-prompts.cjs");

test("cancelling a phone request settles its QR, PIN and transport callbacks once", () => {
  const calls = [];
  const request = {
    id: "11111111-1111-4111-8111-111111111111", kind: "qr", methodChosen: "phone", qrDataUrl: "private-qr",
    detach: () => calls.push("detach"),
    qrAction: action => calls.push(`qr:${action}`),
    callback: value => calls.push(`pin:${value}`),
    transportAction: action => calls.push(`transport:${action}`),
    operation: { end: outcome => calls.push(`end:${outcome}`) },
  };
  const controller = {
    pending: new Map([[request.id, request]]), batchCancelling: false,
    logger: { info() {}, warn() {} }, next: () => calls.push("next"),
  };
  WebAuthnPrompts.prototype.cancel.call(controller, request, "user");
  WebAuthnPrompts.prototype.cancel.call(controller, request, "user");
  assert.deepEqual(calls, ["detach", "qr:cancel", "pin:undefined", "transport:cancel", "end:cancelled", "next"]);
  assert.equal(controller.pending.size, 0);
  assert.equal(request.qrDataUrl, null);
});

test("a failed native cancel callback cannot leave another transport callback unsettled", () => {
  const calls = [];
  const shared = action => calls.push(`shared:${action}`);
  const request = {
    id: "22222222-2222-4222-8222-222222222222", kind: "pin", methodChosen: "security-key",
    callback: () => { calls.push("pin"); throw new Error("native callback failed"); },
    qrAction: shared, transportAction: shared,
    operation: { problem: () => calls.push("problem"), end: outcome => calls.push(`end:${outcome}`) },
  };
  const controller = {
    pending: new Map([[request.id, request]]), batchCancelling: false,
    logger: { info() {}, warn: () => calls.push("warn") }, next: () => calls.push("next"),
  };
  WebAuthnPrompts.prototype.cancel.call(controller, request, "provider-switch");
  assert.deepEqual(calls, ["pin", "problem", "warn", "shared:cancel", "end:unknown", "next"]);
});
