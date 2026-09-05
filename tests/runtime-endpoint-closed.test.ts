import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { assertRuntimeEndpointClosed } from "../src/service";

test("repair refuses an endpoint which can still admit runtime work", async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  try {
    await expect(assertRuntimeEndpointClosed({ host: "127.0.0.1", port: address.port })).rejects.toThrow("still listening");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  await assertRuntimeEndpointClosed({ host: "127.0.0.1", port: address.port });
});

test("repair probes only explicitly configured loopback endpoints", async () => {
  await expect(assertRuntimeEndpointClosed({ host: "example.com", port: 443 })).rejects.toThrow("loopback");
});
