import { expect, test } from "bun:test";
import { assertTurnReferenceScoped } from "../src/adapters/chatgpt-web/mcp-server";

const token = "turn_12345678901234567890123456789012";

test("one-turn connector handle stays in its declared field before tool dispatch", () => {
  expect(() => assertTurnReferenceScoped({ turn_token: token, command: "pwd", options: { env: ["LANG=C"] } }, "turn_token", token)).not.toThrow();
  expect(() => assertTurnReferenceScoped({ request_id: token, answer: "Done." }, "request_id", token)).not.toThrow();
  for (const payload of [
    { turn_token: token, command: `printf '%s' '${token}'` },
    { turn_token: token, options: { files: [{ content: `credential=${token}` }] } },
    { request_id: token, answer: `Used ${token}` },
  ]) {
    expect(() => assertTurnReferenceScoped(payload, "request_id" in payload ? "request_id" : "turn_token", token))
      .toThrow(expect.objectContaining({ code: "connector_token_outside_field" }));
  }
});
