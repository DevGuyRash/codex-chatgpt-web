import { createHash } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { runtimeDiagnostics } from "../../diagnostics/runtime";

type Pending = { sequence: number; method: "tools/call" | "tools/list"; tool?: string; started: number } | null;

/** Observe MCP request/reply delivery without copying tool arguments or results into logs. */
export function observeMcpTransport(inner: Transport, knownTools: ReadonlySet<string>): Transport {
  let sequence = 0;
  const pending = new Map<string | number, Pending>();
  const emit = (name: string, attributes: Record<string, string | number | boolean>) => {
    try {
      const diagnostics = runtimeDiagnostics();
      if (diagnostics) diagnostics.event(name, name.replaceAll(".", " "), attributes);
      else console.error("[chatgpt-web-mcp] " + JSON.stringify({ event: name, ...attributes }));
    } catch { /* Observation must not change transport delivery. */ }
  };
  const rpcId = (value: string | number) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  const observed: Transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    start: () => inner.start(),
    close: () => inner.close(),
    send: async (message, options) => {
      const id = "id" in message ? message.id : undefined;
      const request = id !== undefined && id !== null && !("method" in message) ? pending.get(id) : undefined;
      try {
        await inner.send(message, options);
        if (request) {
          const payload = "result" in message && message.result && typeof message.result === "object"
            ? message.result as Record<string, unknown> : undefined;
          const listed = request.method === "tools/list" && Array.isArray(payload?.tools)
            ? payload.tools.flatMap(tool => tool && typeof tool === "object" && "name" in tool
              && typeof tool.name === "string" && knownTools.has(tool.name) ? [tool.name] : [])
            : undefined;
          emit("mcp.transport_reply_sent", {
            sequence: request.sequence,
            requestIdHash: rpcId(id!),
            method: request.method,
            elapsedMs: Math.round(performance.now() - request.started),
            outcome: "error" in message ? "protocol_error" : "result",
            ...(request.tool ? { tool: request.tool } : {}),
            ...(listed ? { exposedBridgeToolCount: listed.length, hasNativeExec: listed.includes("codex_exec") } : {}),
            ...("result" in message && payload && "isError" in payload ? { toolError: payload.isError === true } : {}),
          });
        }
      } catch (error) {
        if (request) emit("mcp.transport_reply_failed", { sequence: request.sequence, requestIdHash: rpcId(id!), method: request.method });
        throw error;
      } finally {
        if (request && id !== undefined && id !== null) pending.delete(id);
      }
    },
  };
  inner.onmessage = (message, extra) => {
    if ("method" in message && "id" in message
      && (message.method === "tools/call" || message.method === "tools/list")) {
      const id = message.id;
      const tool = message.method === "tools/call" && typeof message.params?.name === "string"
        && knownTools.has(message.params.name) ? message.params.name : undefined;
      if (pending.has(id)) {
        pending.set(id, null);
        emit("mcp.transport_uncorrelated", { requestIdHash: rpcId(id), reason: "duplicate_id" });
      } else if (pending.size >= 1024) {
        emit("mcp.transport_uncorrelated", { requestIdHash: rpcId(id), reason: "tracking_limit" });
      } else {
        const request = { sequence: ++sequence, method: message.method, ...(tool ? { tool } : {}), started: performance.now() } as const;
        pending.set(id, request);
        emit("mcp.transport_request_received", {
          sequence: request.sequence, requestIdHash: rpcId(id), method: request.method,
          ...(request.tool ? { tool: request.tool } : {}),
        });
      }
    }
    observed.onmessage?.(message, extra);
  };
  inner.onclose = () => {
    if (pending.size) emit("mcp.transport_closed", { pendingRequests: pending.size });
    pending.clear();
    observed.onclose?.();
  };
  inner.onerror = error => observed.onerror?.(error);
  return observed;
}
