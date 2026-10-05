import { chatGptWebTraceId, createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
  structuredCompactionSettlementForNativeTurn,
} from "./adapters/chatgpt-web/compaction-handoff";
import { ChatGptNativeTurnInterruptedError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import { campaignCaptureId, captureCampaignContent, omitCampaignCapture } from "./diagnostics/campaign-capture";
import { MAX_CAPTURE_DOCUMENT_BYTES } from "./diagnostics/contracts";
import { assertCampaignRoute, campaignGenerationRestricted } from "./campaign-policy";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
  extractChatGptCompactionSourceRevision,
} from "./adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "./adapters/chatgpt-web/compaction-continuation";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import { adapterErrorEvent } from "./lib/errors";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash, randomUUID } from "node:crypto";
import { DiagnosticError, problemFor } from "./diagnostics/problems";
import { augmentNativeModelCatalog } from "./model-catalog";
import { profileCatalogRefreshCheck } from "./profile-model-catalog";
import type { InterruptCleanupClaims } from "./interrupt-cleanup";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import { forwardNativeCodexRequest, type NativeFetch, type NativeImageEndpoint } from "./native-passthrough";
import { fetchNativeCodex } from "./native-network";
import { isChatGptCompactionTurn } from "./responses/native-metadata";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";
import type { ResponseProducers } from "./response-producers";

type HttpTrackedEndpoint = "models" | "responses" | "compact" | "search" | "unspecified" | NativeImageEndpoint;

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

function safeStreamErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function streamFailureEvidence(
  error: unknown,
  httpTurnId: number,
  endpoint: HttpTrackedEndpoint,
  reader: HttpStreamFailureEvidence["reader"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureEvidence {
  const candidate = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    httpTurnId,
    endpoint,
    reader,
    platform,
    chunks,
    bytes,
    errorName: safeStreamErrorField(candidate.name, "Error"),
    errorCode: safeStreamErrorField(candidate.code, "unknown"),
  };
}

const reportHttpStreamFailure: HttpStreamFailureReporter = evidence => {
  console.warn(`[codex-chatgpt-web] http_stream_failed ${JSON.stringify(evidence)}`);
};

function emitHttpStreamFailure(
  reporter: HttpStreamFailureReporter,
  evidence: HttpStreamFailureEvidence,
): void {
  try {
    reporter(evidence);
  } catch {
    // Diagnostics are a side channel: they must never replace the source stream error or retain
    // HTTP turn ownership after the client has already observed that failure.
  }
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  constructor(private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure, private readonly cleanupClaims?: InterruptCleanupClaims, private readonly physicalSettlement?: (identity: NativeCodexTurnIdentity) => Promise<void>) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): { cancelled: number; settlement: Promise<void> } {
    this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    endpoint: HttpTrackedEndpoint = "unspecified",
  ): Promise<Response> {
    const id = this.nextId++;
    const diagnostic = runtimeDiagnostics()?.begin(`http.${endpoint}`, {}, null);
    let httpStatus: number | undefined;
    let diagnosticFailure = false;
    let diagnosticCancelled = false;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let releaseClaim: (() => void) | undefined;
    let claimUncertain = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      diagnostic?.end(terminalOutcome({ failed: diagnosticFailure, cancelled: abort.signal.aborted || diagnosticCancelled, uncertain: claimUncertain }), { ...(httpStatus ? { "http.response.status_code": httpStatus } : {}) });
      this.active.delete(id);
      if (!abort.signal.aborted && !claimUncertain && releaseClaim) {
        const confirm = () => { try { releaseClaim?.(); } catch { console.error("[chatgpt-web] cleanup ownership receipt could not be released"); } };
        if (tracked.identity && this.physicalSettlement) void this.physicalSettlement(tracked.identity).then(confirm, () => { console.error("[chatgpt-web] physical cleanup remains unconfirmed after HTTP completion"); });
        else confirm();
      }
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const invoke = () => run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        if (!tracked.identity) releaseClaim = this.cleanupClaims?.begin(identity);
        tracked.identity = identity;
        diagnostic?.identify({ id: `${identity.threadId}:${identity.turnId}` });
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      const response = await (diagnostic ? diagnostic.run(invoke) : invoke());
      httpStatus = response.status;
      if (!response.ok && !abort.signal.aborted) { diagnosticFailure = true; diagnostic?.problem(new Error("HTTP request failed"), "Runtime request returned a failure response"); }
      claimUncertain = !response.ok;
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        const reportStreamFailure = this.reportStreamFailure;
        let chunks = 0;
        let bytes = 0;
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              chunks += 1;
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            } catch (error) {
              claimUncertain = true;
              if (!abort.signal.aborted && !diagnosticCancelled && !isDiagnosticCancellation(error)) {
                if (!diagnosticFailure) diagnostic?.problem(error, "Runtime response stream ended unexpectedly");
                diagnosticFailure = true;
              } else diagnosticCancelled = true;
              if (!abort.signal.aborted) {
                emitHttpStreamFailure(reportStreamFailure, streamFailureEvidence(
                  error,
                  id,
                  endpoint,
                  "client",
                  platform,
                  chunks,
                  bytes,
                ));
              }
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            claimUncertain = true;
            diagnosticCancelled = true;
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      let chunks = 0;
      let bytes = 0;
      streamAbortListener = () => {
        void Promise.allSettled([
          reader.cancel(abort.signal.reason),
          clientBody.cancel(abort.signal.reason),
        ]).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks += 1;
            bytes += chunk.value.byteLength;
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch (error) {
          claimUncertain = true;
          if (!abort.signal.aborted && !diagnosticCancelled && !isDiagnosticCancellation(error)) {
            if (!diagnosticFailure) diagnostic?.problem(error, "Runtime response stream ended unexpectedly");
            diagnosticFailure = true;
          } else diagnosticCancelled = true;
          if (!abort.signal.aborted) {
            emitHttpStreamFailure(this.reportStreamFailure, streamFailureEvidence(
              error,
              id,
              endpoint,
              "windows_lifecycle",
              platform,
              chunks,
              bytes,
            ));
          }
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      claimUncertain = true;
      if (!abort.signal.aborted && !diagnosticCancelled && !isDiagnosticCancellation(error)) {
        if (!diagnosticFailure) diagnostic?.problem(error, "Runtime request failed before completing its response");
        diagnosticFailure = true;
      } else diagnosticCancelled = true;
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** Harness-owned handlers and detached capture producers must settle before owner teardown. */
  producers?: ResponseProducers;
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config);
  assertCampaignRoute(route);
  parsed.modelId = route.backendModel;
  // Zero Risk preserves a distinct backend identity. Its immutable Codex effort is only a
  // protocol/catalog value; the manual adapter must never reinterpret it as a ChatGPT selection.
  parsed.options.reasoning = route.interactionMode === "automatic"
    ? route.adapterEffort
    : route.codexEffort;
  return route;
}

interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return { stage, ...(typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { code } : {}) };
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
): Promise<Response> {
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", input => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    onFailure?.(modelCatalogFailure(sent ? "transport" : "request", error));
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) { onFailure?.({ stage: "upstream" }); return upstream; }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    onFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

async function nativeImagesRequest(
  req: Request,
  endpoint: NativeImageEndpoint,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  if (campaignGenerationRestricted()) {
    return formatErrorResponse(403, "permission_error", "Native image generation is disabled for this scoped non-Pro campaign");
  }
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    return formatErrorResponse(401, "authentication_error", "Native image requests require incoming Codex Bearer authorization");
  }
  try { return await forwardNativeCodexRequest(req, endpoint, fetchUpstream); }
  catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const work = () => responseRequestImpl(req, config, adapterFactory, options);
  return options.producers ? options.producers.run(work) : work();
}

async function responseRequestImpl(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory,
  options: ResponseRequestOptions,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  options.producers?.signal.throwIfAborted();
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    if (campaignGenerationRestricted()) return formatErrorResponse(403, "permission_error", "Native model fallback is disabled for this scoped ChatGPT Web campaign");
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT Web cannot read this encrypted cross-backend subagent payload. "
        + "Start a new Compatibility V1 task, or delegate from a Web model whose collaboration call uses the plaintext-delivery marker.",
    );
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  const compactionTurn = isChatGptCompactionTurn(parsed);
  const rememberCompletedResponse = (response: Record<string, unknown>): void => {
    if (!compaction) {
      if (options.rememberState !== false) rememberResponseState(parsed._rawBody, response, { force: true });
      return;
    }
    if (response.status !== "completed") return;
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId || !Array.isArray(response.output) || response.output.length !== 1) return;
    const item = response.output[0];
    if (item?.type !== "compaction" || typeof item.encrypted_content !== "string") return;
    const summary = decodeCompactionSummary(item.encrypted_content);
    if (!summary) return;
    const source = extractChatGptCompactionSourceRevision(parsed);
    const body = parsed._rawBody as { input?: unknown[] };
    // v1 installs the bounded user-message output, whereas v2 retains the original source.
    // Authenticate both exact producer-defined representations, never arbitrary rewrites.
    const v1Source = extractChatGptCompactionSourceRevision({
      ...parsed,
      _rawBody: { ...body, input: buildCompactV1Output(extractCompactUserMessages(body.input), summary) },
    });
    rememberCompactionContinuation(parsed, identity, [source, v1Source], summary);
  };
  if (compactionTurn && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compactionTurn) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    // Local memento already carries Codex's own summarization instruction. Only remote
    // compaction needs this bridge-authored prompt and an encrypted compaction output item.
    if (compaction) parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const provider = providerConfig(config);
  let traceId: string | undefined;
  try {
    traceId = chatGptWebTraceId(provider, parsed);
  } catch (error) {
    // A cancelled browser session can only exist after the adapter accepted canonical native
    // turn identity and user-revision metadata. Requests without that identity have no matching
    // trace tombstone; preserve the adapter's existing strict validation/error path below.
    const message = error instanceof Error ? error.message : String(error);
    if (message === CHATGPT_TURN_REVISION_CONFLICT_MESSAGE) {
      // Codex can reopen an interrupted task with only refreshed developer/skill context under a
      // new turn_id. Its last human prompt still belongs to the stopped turn and must not be
      // replayed as new work. HTTP 400 makes that malformed recovery request terminal instead of
      // allowing Codex to retry it as an upstream 502.
      return formatErrorResponse(400, "invalid_request_error", message);
    }
    if (!message.includes("requires native Codex turn_id metadata")
      && !message.includes("requires a current-turn user message")) throw error;
  }
  const cancelledError = traceId ? chatGptTurnSessions.cancelledError(traceId) : undefined;
  if (cancelledError) {
    // Codex retries unknown streamed response.failed codes. A replay after the user explicitly
    // closed the only browser document is instead a terminal client state: repeating that exact
    // request is invalid and must not recreate the DOM. Codex maps HTTP 400 to its non-retryable
    // InvalidRequest category while the body preserves the real client_cancelled classification.
    return new Response(JSON.stringify({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: cancelledError.message,
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  options.producers?.signal.throwIfAborted();
  const adapter = adapterFactory(provider);
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    const operation = runtimeDiagnostics()?.begin("adapter.turn", { "model.requested": responseModel, "model.backend": parsed.modelId, "model.effort": parsed.options.reasoning ?? "unspecified" });
    const terminal: { outcome: "succeeded" | "failed" | "cancelled" | "unknown" } = { outcome: "unknown" };
    // Do not turn an already-emitted terminal into cancellation merely because its
    // output acknowledgement is still pending when the owner stops admission.
    const cancelOwnedWork = () => {
      if (terminal.outcome === "unknown") abort.abort(options.producers?.signal.reason);
    };
    options.producers?.signal.addEventListener("abort", cancelOwnedWork, { once: true });
    const capture = Boolean(campaignCaptureId()), captured: string[] = [];
    let capturedBytes = 0, captureOmitted = false;
    const observe = (event: AdapterEvent) => {
      if (capture && event.type !== "heartbeat") {
        const line = JSON.stringify(event);
        const bytes = Buffer.byteLength(line) + 1;
        if (capturedBytes + bytes <= MAX_CAPTURE_DOCUMENT_BYTES) { captured.push(line); capturedBytes += bytes; }
        else captureOmitted = true;
      }
      if (event.type === "error") {
        terminal.outcome = event.status === 499 ? "cancelled" : "failed";
        if (terminal.outcome === "failed") operation?.problem(event, "Adapter failed without complete source evidence");
      } else if (event.type === "done" && terminal.outcome === "unknown") terminal.outcome = "succeeded";
      else if (event.type === "incomplete" && terminal.outcome !== "failed") terminal.outcome = "unknown";
      options.onAdapterEvent?.(event); queue.push(event);
    };
    try {
      if (capture) await captureCampaignContent("prompt", JSON.stringify(raw), operation?.context);
      // An admitted handler can be suspended in capture when its owner starts teardown.
      options.producers?.signal.throwIfAborted();
      const work = () => adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, observe);
      await (operation ? operation.run(work) : work());
    } catch (error) {
      const event = adapterErrorEvent(error);
      observe(event);
    } finally {
      options.producers?.signal.removeEventListener("abort", cancelOwnedWork);
      if (capture) {
        await captureCampaignContent("output", captured.join("\n"), operation?.context);
        if (captureOmitted) await omitCampaignCapture("too-large", operation?.context);
      }
      operation?.end(abort.signal.aborted && terminal.outcome !== "failed" ? "cancelled" : terminal.outcome, { "completion.observed": terminal.outcome === "succeeded" });
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    if (options.producers) void options.producers.run(run);
    else void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(provider.chatgptWeb?.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: provider.chatgptWeb.stallTimeoutSec }
          : {}),
        ...(compaction ? { compaction: true } : {}),
        onCompletedResponse: rememberCompletedResponse,
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (options.producers) await options.producers.run(run);
  else await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compaction ? { compaction: true } : {}),
  });
  rememberCompletedResponse(json);
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: Pick<ResponseRequestOptions, "onTurnIdentity" | "producers"> = {},
): Promise<Response> {
  const work = () => compactRequestImpl(req, config, adapterFactory, options);
  return options.producers ? options.producers.run(work) : work();
}

async function compactRequestImpl(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory,
  options: Pick<ResponseRequestOptions, "onTurnIdentity" | "producers">,
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  options.producers?.signal.throwIfAborted();
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    if (campaignGenerationRestricted()) return formatErrorResponse(403, "permission_error", "Native model fallback is disabled for this scoped ChatGPT Web campaign");
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
    assertCampaignRoute(route);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, options);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: { fetchUpstream?: NativeFetch; adapterFactory?: ChatGptWebAdapterFactory; cleanupClaims?: InterruptCleanupClaims; responseProducers?: ResponseProducers } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  const startedAt = Date.now();
  const checkProfileCatalog = profileCatalogRefreshCheck(config);
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let modelCatalogRequests = 0;
  let lastModelCatalogResult: { request: number; at: string; status: number; failure?: ModelCatalogFailure } | null = null;
  const cancellations = new Map<string, {
    id: string;
    status: "accepted" | "completed" | "failed";
    startedAt: number;
    cancelledBrokerTurns: number;
    cancelledBrowserTurns?: number;
    cancelledCompactionRuns?: number;
    failureCode?: string;
  }>();
  const httpTurns = new HttpTurnCounter(undefined, dependencies.cleanupClaims, identity => Promise.all([
    chatGptTurnSessions.physicalSettlementForNativeTurn(identity.threadId, identity.turnId),
    structuredCompactionSettlementForNativeTurn(identity.threadId, identity.turnId),
  ]).then(() => undefined));
  const ownedResponse = (work: () => Promise<Response>) => dependencies.responseProducers
    ? dependencies.responseProducers.run(work) : work();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const profileCatalog = checkProfileCatalog();
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining && profileCatalog?.ready !== false,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          model_catalog_requests: modelCatalogRequests,
          last_model_catalog_result: lastModelCatalogResult,
          profile_model_catalog: profileCatalog,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        turnBroker?.setExternalOwnersAccepted(!draining);
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "POST" && (url.pathname === "/admin/cancel-turn"
        || url.pathname === "/admin/cancel-status")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let traceId: string;
        try {
          const body = await req.json() as { traceId?: unknown };
          traceId = typeof body?.traceId === "string" ? body.traceId : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        let record = cancellations.get(traceId);
        if (url.pathname === "/admin/cancel-status") {
          return Response.json(record ? {
            status: record.status,
            trace_id: traceId,
            cancellation_id: record.id,
            cancelled_broker_turns: record.cancelledBrokerTurns,
            ...(record.cancelledBrowserTurns === undefined ? {} : { cancelled_browser_turns: record.cancelledBrowserTurns }),
            ...(record.cancelledCompactionRuns === undefined ? {} : { cancelled_compaction_runs: record.cancelledCompactionRuns }),
            ...(record.failureCode ? { failure_code: record.failureCode } : {}),
          } : { status: "missing", trace_id: traceId });
        }
        if (!record) {
          for (const [key, previous] of cancellations) {
            if (cancellations.size <= 256) break;
            if (previous.status !== "accepted" && Date.now() - previous.startedAt > 10 * 60_000) cancellations.delete(key);
          }
          record = { id: randomUUID(), status: "accepted", startedAt: Date.now(), cancelledBrokerTurns: 0 };
          cancellations.set(traceId, record);
          const activeRecord = record;
          const operation = runtimeDiagnostics()?.begin("turn.cancel", { traceId }, null);
          try {
            const reason = chatGptBrowserTabClosedError();
            // Both owners receive their exact cancellation before the acknowledgement is sent.
            // Settlement continues under this process-retained receipt; another request reads
            // its status and never invokes cancellation a second time.
            const compactionCancellation = cancelStructuredCompactionTrace(traceId, reason);
            const browserCancellation = chatGptTurnSessions.cancelTrace(traceId, reason);
            activeRecord.cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
            void Promise.all([browserCancellation, compactionCancellation]).then(([browserTurns, compactionRuns]) => {
              activeRecord.cancelledBrowserTurns = browserTurns;
              activeRecord.cancelledCompactionRuns = compactionRuns;
              if (browserTurns + compactionRuns + activeRecord.cancelledBrokerTurns === 0) {
                throw new DiagnosticError({ code: "cancel_target_absent", message: "No active exact turn acknowledged cancellation", origin: "runtime", stage: "browser.cancel", retryable: false });
              }
              activeRecord.status = "completed";
              operation?.end("succeeded");
            }).catch(error => {
              activeRecord.status = "failed";
              activeRecord.failureCode = problemFor(error).code;
              operation?.problem(error);
              operation?.end("failed");
            });
          } catch (error) {
            activeRecord.status = "failed";
            activeRecord.failureCode = problemFor(error).code;
            operation?.problem(error);
            operation?.end("failed");
          }
        }
        return Response.json({
          status: record.status,
          trace_id: traceId,
          cancellation_id: record.id,
          cancelled_broker_turns: record.cancelledBrokerTurns,
          ...(record.failureCode ? { failure_code: record.failureCode } : {}),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let identity: NativeCodexTurnIdentity;
        try {
          const body = await req.json() as { threadId?: unknown; turnId?: unknown };
          const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
          const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
            throw new Error("native Codex threadId or turnId is invalid");
          }
          identity = { threadId, turnId };
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = new ChatGptNativeTurnInterruptedError();
        const releaseClaims = dependencies.cleanupClaims?.captureSettlement(identity);
        const browserCancellation = chatGptTurnSessions.cancelNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const compactionCancellation = cancelStructuredCompactionNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
        const settlement = Promise.allSettled([
          browserCancellation.settlement,
          compactionCancellation.settlement,
          httpCancellation.settlement,
        ]);
        void settlement.then(results => {
          if (httpCancellation.cancelled + browserCancellation.cancelled > 0 && compactionCancellation.cancelled === 0 && results.every(result => result.status === "fulfilled")) {
            try { releaseClaims?.(); } catch { console.error("[chatgpt-web] interrupted cleanup ownership receipt could not be released"); }
          }
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(
                `[chatgpt-web] interrupted turn cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              );
            }
          }
        });
        const cleanupStatus = await Promise.race([
          settlement.then(results => results.every(result => result.status === "fulfilled") ? compactionCancellation.cancelled > 0 ? "pending" : "completed" : "failed"),
          Bun.sleep(100).then(() => "pending"),
        ]);
        return Response.json({
          status: "ok",
          cancelled_http_turns: httpCancellation.cancelled,
          cancelled_browser_turns: browserCancellation.cancelled,
          cancelled_compaction_runs: compactionCancellation.cancelled,
          cleanup_status: httpCancellation.cancelled + browserCancellation.cancelled + compactionCancellation.cancelled === 0 ? "armed" : cleanupStatus,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const reason = new Error("Active turn cancelled by launcher");
        // Abort shared compaction owners before clearing their retained source sessions. The
        // owner signal is the only cancellation boundary for a fresh fallback not in the session
        // registry.
        const compactionCancellation = cancelAllStructuredCompactions(reason);
        const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
        const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
          httpTurns.cancelAll(reason),
          compactionCancellation,
        ]);
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancelledHttpTurns,
          cancelled_browser_turns: cancelledBrowserTurns,
          cancelled_compaction_runs: cancelledCompactionRuns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        if (dependencies.responseProducers) return Response.json({ status: "refused", reason: "Runtime owner must settle response producers before shutdown" }, { status: 409 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async signal => {
          const request = ++modelCatalogRequests;
          let catalogConfig: AppConfig;
          try {
            catalogConfig = {
              ...config,
              subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol, config.integrationTarget),
            };
          } catch (error) {
            const failure = modelCatalogFailure("config", error);
            lastModelCatalogResult = { request, at: new Date().toISOString(), status: 500, failure };
            return formatErrorResponse(
              500,
              "server_error",
              `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          let failure: ModelCatalogFailure | undefined;
          const response = await modelsRequest(
            new Request(req, { signal }),
            catalogConfig,
            dependencies.fetchUpstream,
            () => readCodexModelContextOverride(config.integrationTarget),
            observed => { failure = observed; },
          );
          lastModelCatalogResult = { request, at: new Date().toISOString(), status: response.status, ...(failure ? { failure } : {}) };
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return response;
        }, req.signal, process.platform, "models");
      }
      if (profileCatalog?.ready === false && url.pathname.startsWith("/v1/")) return formatErrorResponse(409, "invalid_request_error", `Profile configuration needs attention: ${profileCatalog.error ?? "catalog is unavailable"}`);
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return ownedResponse(() => httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity, producers: dependencies.responseProducers },
          ),
          req.signal,
          process.platform,
          "responses",
        ));
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return ownedResponse(() => httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity, producers: dependencies.responseProducers },
          ),
          req.signal,
          process.platform,
          "compact",
        ));
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
          req.signal,
          process.platform,
          "search",
        );
      }
      if (req.method === "POST" && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        const endpoint: NativeImageEndpoint = url.pathname === "/v1/images/generations"
          ? "images/generations" : "images/edits";
        return httpTurns.track(
          signal => nativeImagesRequest(new Request(req, { signal }), endpoint, dependencies.fetchUpstream),
          req.signal,
          process.platform,
          endpoint,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        chatGptTurnSessions.clearAndReleaseRetained(),
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
      await flushResponseState();
      await closeRuntimeDiagnostics();
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // A harness supplying response ownership also owns teardown. Standalone signal
  // cleanup must not race its producer join and close shared diagnostics early.
  if (!dependencies.responseProducers) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return server;
}
import { closeRuntimeDiagnostics, runtimeDiagnostics } from "./diagnostics/runtime";
import { isDiagnosticCancellation, terminalOutcome } from "./diagnostics/outcome";
