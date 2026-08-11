import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import { analyzeExchange } from "./analyzer.js";
import { compareVersions } from "./compare.js";
import { MAX_PROFILE_WARNINGS, MAX_PROXY_REQUEST_BYTES } from "./limits.js";
import { redactText, safeError } from "./redaction.js";
import { RunStore } from "./store.js";
import type { PricingRecord, ProfileRun } from "./types.js";
import { renderDashboard } from "./ui/dashboard.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  store?: RunStore;
  upstream?: string;
  apiKey?: string;
  allowRemote?: boolean;
  allowedHosts?: readonly string[];
  forwardHeaders?: readonly string[];
  upstreamTimeoutMs?: number;
  captureMode?: "none" | "redacted";
  pricing?: PricingRecord[];
  defaultLabel?: string;
  defaultPromptVersion?: string;
  quiet?: boolean;
  onRun?: (run: ProfileRun) => void | Promise<void>;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PRIVATE_PROXY_HEADERS = new Set([
  "cf-connecting-ip",
  "cf-visitor",
  "forwarded",
  "origin",
  "referer",
  "true-client-ip",
  "via",
  "x-envoy-original-path",
  "x-client-cert",
  "x-ms-client-principal",
  "x-original-url",
  "x-original-uri",
  "x-real-ip",
]);
const DEFAULT_FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "api-key",
  "authorization",
  "content-type",
  "idempotency-key",
  "user-agent",
  "x-api-key",
  "x-goog-api-key",
  "x-goog-user-project",
]);
const MAX_RESPONSE_CAPTURE_BYTES = 5 * 1024 * 1024;
const MAX_DECOMPRESSED_CAPTURE_BYTES = 10 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

type ResolvedServerOptions = ServerOptions & {
  host: string;
  port: number;
  store: RunStore;
  allowedHostnames: ReadonlySet<string>;
  forwardedRequestHeaders: ReadonlySet<string>;
  upstreamTimeoutMs: number;
};

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const allowedHostnames = new Set((options.allowedHosts ?? []).map(normalizeAllowedHostname));
  const forwardedRequestHeaders = new Set((options.forwardHeaders ?? []).map(normalizeForwardHeaderName));
  if (!isLoopback(host) && !options.allowRemote) {
    throw new Error(
      `Refusing to bind to ${host}. Ctxprof contains prompt data; pass --allow-remote only behind a trusted network boundary.`,
    );
  }
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs <= 0 || upstreamTimeoutMs > 2_147_483_647) {
    throw new Error("upstreamTimeoutMs must be a positive integer no greater than 2147483647.");
  }
  if (options.upstream) validateUpstream(options.upstream);
  const store = options.store ?? new RunStore();
  await store.init();
  const server = createServer((request, response) => {
    void route(request, response, {
      ...options,
      host,
      port: requestedPort,
      store,
      allowedHostnames,
      forwardedRequestHeaders,
      upstreamTimeoutMs,
    }).catch((error) => {
      if (!response.headersSent) json(response, 500, { error: "Internal error", detail: safeError(error) });
      else {
        process.stderr.write(`ctxprof: ${safeError(error)}\n`);
        if (!response.writableEnded) response.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const displayHost = isIP(host.replace(/^\[|\]$/g, "")) === 6 ? `[${host.replace(/^\[|\]$/g, "")}]` : host;
  return {
    server,
    host,
    port,
    url: `http://${displayHost}:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResolvedServerOptions,
): Promise<void> {
  const boundaryError = requestBoundaryError(request, options);
  if (boundaryError) {
    json(response, 403, { error: boundaryError });
    return;
  }
  const requestUrl = new URL(request.url ?? "/", "http://ctxprof.local");
  if (request.method === "GET" && requestUrl.pathname === "/") {
    html(response, 200, renderDashboard([], {
      mode: options.upstream ? "proxy" : "store",
      title: "Ctxprof · live context profile",
    }));
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    json(response, 200, { status: "ok", storage: options.store.directory, proxy: Boolean(options.upstream) });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/runs") {
    const limit = clampInteger(requestUrl.searchParams.get("limit"), 1, 5_000, 1_000);
    const runs = await options.store.list(limit);
    json(response, 200, { runs, storageBytes: await options.store.sizeBytes() });
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/api/compare") {
    const from = requestUrl.searchParams.get("from");
    const to = requestUrl.searchParams.get("to");
    if (!from || !to) {
      json(response, 400, { error: "Both from and to prompt versions are required." });
      return;
    }
    const runs = await options.store.list(5_000);
    json(response, 200, compareVersions(runs, from, to));
    return;
  }
  if (requestUrl.pathname.startsWith("/v1/")) {
    if (!options.upstream) {
      json(response, 404, { error: "Proxy mode is not enabled. Start with `ctxprof proxy`." });
      return;
    }
    await proxyRequest(request, response, requestUrl, options);
    return;
  }
  json(response, 404, { error: "Not found" });
}

async function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  options: ResolvedServerOptions,
): Promise<void> {
  if (request.method !== "POST") {
    json(response, 405, { error: "Ctxprof currently profiles JSON POST requests only." });
    return;
  }
  if (!isJsonContentType(protocolHeaderValue(request.headers["content-type"]))) {
    json(response, 415, { error: "Ctxprof proxy requests must use application/json or application/*+json." });
    return;
  }
  const requestEncoding = protocolHeaderValue(request.headers["content-encoding"]);
  if (requestEncoding && requestEncoding.toLowerCase() !== "identity") {
    json(response, 415, { error: "Ctxprof does not accept compressed request bodies." });
    return;
  }
  let rawRequest: Buffer;
  try {
    rawRequest = await readBody(request, MAX_PROXY_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      json(response, 413, { error: error.message });
      return;
    }
    throw error;
  }
  let parsedRequest: unknown;
  try {
    parsedRequest = JSON.parse(rawRequest.toString("utf8"));
  } catch {
    json(response, 400, { error: "Expected a JSON request body." });
    return;
  }
  const started = performance.now();
  const upstreamUrl = makeUpstreamUrl(options.upstream ?? "", requestUrl);
  const headers = forwardRequestHeaders(
    request.headers,
    options.apiKey,
    rawRequest.length,
    options.forwardedRequestHeaders,
  );
  const label = headerValue(request.headers["x-ctxprof-label"]) ?? options.defaultLabel;
  const promptVersion =
    headerValue(request.headers["x-ctxprof-version"]) ?? options.defaultPromptVersion;
  const controller = new AbortController();
  let abortKind: "downstream" | "timeout" | null = null;
  let downstreamFinished = false;
  const abort = (kind: "downstream" | "timeout"): void => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort(new Error(kind === "timeout" ? "Upstream request timed out." : "Downstream connection closed."));
  };
  const onRequestAborted = (): void => abort("downstream");
  const onResponseFinish = (): void => { downstreamFinished = true; };
  const onResponseClose = (): void => {
    if (!downstreamFinished) abort("downstream");
  };
  request.once("aborted", onRequestAborted);
  response.once("finish", onResponseFinish);
  response.once("close", onResponseClose);
  const timeout = setTimeout(() => abort("timeout"), options.upstreamTimeoutMs);
  try {
    const upstreamResponse = await openUpstream(upstreamUrl, headers, rawRequest, controller.signal);
    const destroyUpstream = (): void => {
      upstreamResponse.destroy(controller.signal.reason instanceof Error ? controller.signal.reason : undefined);
    };
    controller.signal.addEventListener("abort", destroyUpstream, { once: true });
    const status = upstreamResponse.statusCode ?? 502;
    copyResponseHeaders(upstreamResponse.headers, response);
    response.statusCode = status;
    const capture = new BoundedResponseCapture(MAX_RESPONSE_CAPTURE_BYTES);
    try {
      for await (const rawChunk of upstreamResponse) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const writable = await writeWithBackpressure(response, chunk);
        if (!writable) {
          abort("downstream");
          throw controller.signal.reason;
        }
        capture.add(chunk);
      }
    } finally {
      controller.signal.removeEventListener("abort", destroyUpstream);
    }
    if (!response.destroyed) response.end();
    const capturedResponse = await parseCapturedPayload(
      capture,
      protocolHeaderValue(upstreamResponse.headers["content-type"]) ?? "",
      protocolHeaderValue(upstreamResponse.headers["content-encoding"]) ?? "identity",
    );
    await recordRunSafely(parsedRequest, capturedResponse.value, {
      endpoint: requestUrl.pathname,
      status,
      durationMs: Math.round(performance.now() - started),
      label,
      promptVersion,
      options,
      responseCapture: capturedResponse,
    });
  } catch (error) {
    const downstreamAbort = abortKind === "downstream";
    const status = abortKind === "timeout" ? 504 : downstreamAbort ? 499 : 502;
    const detail = abortKind === "timeout" ? "Upstream request timed out." : safeError(error);
    if (!downstreamAbort) {
      if (!response.headersSent && !response.destroyed) {
        json(response, status, {
          error: status === 504 ? "Upstream request timed out" : "Upstream request failed",
          detail,
        });
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
    await recordRunSafely(parsedRequest, { error: detail }, {
      endpoint: requestUrl.pathname,
      status,
      durationMs: Math.round(performance.now() - started),
      label,
      promptVersion,
      options,
    });
  } finally {
    clearTimeout(timeout);
    request.off("aborted", onRequestAborted);
    response.off("finish", onResponseFinish);
    response.off("close", onResponseClose);
  }
}

interface RecordOptions {
  endpoint: string;
  status: number;
  durationMs: number;
  label: string | undefined;
  promptVersion: string | undefined;
  options: Required<Pick<ServerOptions, "store">> & ServerOptions;
  responseCapture?: CapturedPayload;
}

async function recordRun(request: unknown, response: unknown, record: RecordOptions): Promise<void> {
  const run = analyzeExchange(request, response, {
    endpoint: record.endpoint,
    status: record.status,
    durationMs: record.durationMs,
    source: "proxy",
    captureMode: record.options.captureMode ?? "redacted",
    pricing: record.options.pricing ?? [],
    ...(record.label ? { label: record.label } : {}),
    ...(record.promptVersion ? { promptVersion: record.promptVersion } : {}),
  });
  if (record.responseCapture?.truncated) {
    run.exchange.truncated = true;
    const usageRecovered = record.responseCapture.usageRecovered;
    if (!usageRecovered) {
      const fallbackOutputTokens = Math.max(
        run.totals.outputTokens,
        Math.max(1, Math.ceil(record.responseCapture.totalBytes / 4)),
      );
      run.totals.outputTokens = fallbackOutputTokens;
      run.totals.totalTokens =
        (run.totals.providerInputTokens ?? run.totals.estimatedInputTokens) + fallbackOutputTokens;
      if (run.pricing) {
        run.totals.estimatedOutputCostUsd = roundUsd(
          (fallbackOutputTokens / 1_000_000) * run.pricing.outputPerMillionUsd,
        );
        run.totals.estimatedTotalCostUsd = run.totals.estimatedInputCostUsd === null
          ? null
          : roundUsd(run.totals.estimatedInputCostUsd + run.totals.estimatedOutputCostUsd);
      }
    }
    appendBoundedWarning(run, {
      code: "truncated-response",
      severity: "warning",
      title: "Response capture is incomplete",
      detail: usageRecovered
        ? `Ctxprof retained the provider's final output usage, but only sampled a bounded first/last window from the ${formatBytes(record.responseCapture.totalBytes)} response.`
        : `Provider usage was not recoverable. Output tokens use a byte-based fallback for the ${formatBytes(record.responseCapture.totalBytes)} response and must not be treated as an exact zero.`,
    });
  }
  await record.options.store.append(run);
  await record.options.onRun?.(run);
  if (!record.options.quiet) {
    const tokens = run.totals.providerInputTokens ?? run.totals.estimatedInputTokens;
    process.stdout.write(
      `captured ${run.model} · ${tokens.toLocaleString()} input tok · ${run.durationMs ?? 0} ms · ${run.promptVersion}\n`,
    );
  }
}

function appendBoundedWarning(run: ProfileRun, warning: ProfileRun["warnings"][number]): void {
  if (run.warnings.length >= MAX_PROFILE_WARNINGS) {
    const protectedWarning = run.warnings.find((entry) => entry.code === "analysis-truncated");
    const ordinary = run.warnings.filter((entry) => entry !== protectedWarning);
    run.warnings = ordinary.slice(0, MAX_PROFILE_WARNINGS - (protectedWarning ? 2 : 1));
    if (protectedWarning) run.warnings.push(protectedWarning);
  }
  run.warnings.push(warning);
}

async function recordRunSafely(request: unknown, response: unknown, record: RecordOptions): Promise<void> {
  try {
    await recordRun(request, response, record);
  } catch (error) {
    // Observation must never turn a successful upstream response into a proxy
    // failure. Storage and callback errors stay visible on stderr.
    process.stderr.write(`ctxprof: capture failed: ${safeError(error)}\n`);
  }
}

function parseUpstreamPayload(value: string, contentType: string): unknown {
  if (!value) return null;
  if (contentType.includes("text/event-stream") || value.startsWith("data:")) {
    return summarizeStreamEvents(parseSseEvents(value), false);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: redactText(value) };
  }
}

interface CapturedPayload {
  value: unknown;
  truncated: boolean;
  usageRecovered: boolean;
  totalBytes: number;
}

class BoundedResponseCapture {
  readonly limit: number;
  readonly headLimit: number;
  readonly tailLimit: number;
  totalBytes = 0;
  private headBytes = 0;
  private tailBytes = 0;
  private readonly headChunks: Buffer[] = [];
  private readonly tailChunks: Buffer[] = [];
  private fullChunks: Buffer[] | null = [];

  constructor(limit: number) {
    this.limit = limit;
    this.headLimit = Math.floor(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  add(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.fullChunks) {
      if (this.totalBytes <= this.limit) this.fullChunks.push(chunk);
      else this.fullChunks = null;
    }
    if (this.headBytes < this.headLimit) {
      const length = Math.min(chunk.length, this.headLimit - this.headBytes);
      this.headChunks.push(Buffer.from(chunk.subarray(0, length)));
      this.headBytes += length;
    }
    this.tailChunks.push(Buffer.from(chunk));
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailLimit) {
      const first = this.tailChunks[0];
      if (!first) break;
      const excess = this.tailBytes - this.tailLimit;
      if (first.length <= excess) {
        this.tailChunks.shift();
        this.tailBytes -= first.length;
      } else {
        this.tailChunks[0] = Buffer.from(first.subarray(excess));
        this.tailBytes -= excess;
      }
    }
  }

  get truncated(): boolean {
    return this.totalBytes > this.limit;
  }

  full(): Buffer | null {
    return this.fullChunks ? Buffer.concat(this.fullChunks, this.totalBytes) : null;
  }

  head(): Buffer {
    return Buffer.concat(this.headChunks, this.headBytes);
  }

  tail(): Buffer {
    return Buffer.concat(this.tailChunks, this.tailBytes);
  }
}

async function parseCapturedPayload(
  capture: BoundedResponseCapture,
  contentType: string,
  contentEncoding: string,
): Promise<CapturedPayload> {
  const normalizedEncoding = contentEncoding.trim().toLowerCase();
  const full = capture.full();
  if (full) {
    const decoded = await decodeCapturedBody(full, normalizedEncoding);
    if (decoded) {
      const value = parseUpstreamPayload(decoded.toString("utf8"), contentType);
      return {
        value,
        truncated: false,
        usageRecovered: hasProviderUsage(value),
        totalBytes: capture.totalBytes,
      };
    }
    return {
      value: { capture_truncated: true, content_encoding: safeHeaderField(normalizedEncoding) },
      truncated: true,
      usageRecovered: false,
      totalBytes: capture.totalBytes,
    };
  }

  if (normalizedEncoding && normalizedEncoding !== "identity") {
    return {
      value: { capture_truncated: true, content_encoding: safeHeaderField(normalizedEncoding) },
      truncated: true,
      usageRecovered: false,
      totalBytes: capture.totalBytes,
    };
  }

  const head = capture.head().toString("utf8");
  const tailBuffer = capture.tail();
  const tail = tailBuffer.toString("utf8");
  let value: unknown;
  if (contentType.includes("text/event-stream") || head.startsWith("data:")) {
    value = summarizeStreamEvents(
      [...parseSseEvents(head), ...parseSseEvents(tail)],
      true,
    );
  } else {
    const usage = extractLastJsonObjectProperty(tail, "usage");
    const model = extractJsonStringProperty(head, "model") ?? extractJsonStringProperty(tail, "model");
    value = {
      capture_truncated: true,
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
    };
  }
  return {
    value,
    truncated: true,
    usageRecovered: hasProviderUsage(value),
    totalBytes: capture.totalBytes,
  };
}

function parseSseEvents(value: string): unknown[] {
  const events: unknown[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]" || payload.length > MAX_RESPONSE_CAPTURE_BYTES) continue;
    try {
      events.push(JSON.parse(payload) as unknown);
    } catch {
      // A bounded head/tail sample can end inside an event. The final usage
      // event is parsed independently from the retained tail.
    }
  }
  return events;
}

function summarizeStreamEvents(events: unknown[], truncated: boolean): unknown {
  const withUsage = [...events].reverse().find((event) => {
    if (!isRecord(event)) return false;
    return isRecord(event.usage) || (isRecord(event.response) && isRecord(event.response.usage));
  });
  const usage = isRecord(withUsage) && isRecord(withUsage.usage)
    ? withUsage.usage
    : isRecord(withUsage) && isRecord(withUsage.response) && isRecord(withUsage.response.usage)
      ? withUsage.response.usage
      : undefined;
  const withModel = events.find((event) =>
    isRecord(event) && (
      typeof event.model === "string" ||
      (isRecord(event.response) && typeof event.response.model === "string")
    ));
  const model = isRecord(withModel) && typeof withModel.model === "string"
    ? withModel.model
    : isRecord(withModel) && isRecord(withModel.response) && typeof withModel.response.model === "string"
      ? withModel.response.model
      : undefined;
  return {
    events,
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(truncated ? { capture_truncated: true } : {}),
  };
}

function hasProviderUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(value.response) && isRecord(value.response.usage)
      ? value.response.usage
      : null;
  if (!usage) return false;
  return ["completion_tokens", "output_tokens"].some(
    (key) => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0,
  );
}

function extractLastJsonObjectProperty(value: string, property: string): Record<string, unknown> | null {
  const needle = `"${property}"`;
  let index = value.lastIndexOf(needle);
  while (index >= 0) {
    if (!isEscaped(value, index)) {
      let cursor = index + needle.length;
      while (/\s/.test(value[cursor] ?? "")) cursor += 1;
      if (value[cursor] === ":") {
        cursor += 1;
        while (/\s/.test(value[cursor] ?? "")) cursor += 1;
        if (value[cursor] === "{") {
          const end = findJsonObjectEnd(value, cursor);
          if (end >= 0) {
            try {
              const parsed = JSON.parse(value.slice(cursor, end + 1)) as unknown;
              if (isRecord(parsed)) return parsed;
            } catch {
              // Continue searching an earlier property occurrence.
            }
          }
        }
      }
    }
    index = value.lastIndexOf(needle, index - 1);
  }
  return null;
}

function findJsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function extractJsonStringProperty(value: string, property: string): string | undefined {
  const pattern = new RegExp(`"${property}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "g");
  const match = pattern.exec(value);
  if (!match?.[1]) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

async function decodeCapturedBody(value: Buffer, contentEncoding: string): Promise<Buffer | null> {
  const encodings = contentEncoding.split(",").map((entry) => entry.trim()).filter(Boolean);
  let decoded = value;
  try {
    for (const encoding of encodings.reverse()) {
      if (encoding === "identity") continue;
      decoded = await decompressOnce(decoded, encoding);
    }
    return decoded;
  } catch {
    return null;
  }
}

function decompressOnce(value: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer): void => error ? reject(error) : resolve(result);
    const options = { maxOutputLength: MAX_DECOMPRESSED_CAPTURE_BYTES };
    if (encoding === "gzip" || encoding === "x-gzip") gunzip(value, options, callback);
    else if (encoding === "deflate") inflate(value, options, callback);
    else if (encoding === "br") brotliDecompress(value, options, callback);
    else reject(new Error(`Unsupported content encoding: ${encoding}`));
  });
}

function forwardRequestHeaders(
  headers: IncomingHttpHeaders,
  apiKey: string | undefined,
  contentLength: number,
  additionalHeaders: ReadonlySet<string>,
): Headers {
  const outgoing = new Headers();
  const connectionHeaders = new Set(
    (protocolHeaderValue(headers.connection) ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  for (const [name, rawValue] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP.has(lower) ||
      connectionHeaders.has(lower) ||
      lower.startsWith("x-ctxprof-") ||
      isPrivateProxyHeader(lower) ||
      lower === "accept-encoding" ||
      lower === "content-encoding" ||
      lower === "content-length" ||
      !isAllowedForwardHeader(lower, additionalHeaders)
    ) continue;
    if (rawValue !== undefined) outgoing.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  if (!outgoing.has("authorization") && apiKey) outgoing.set("authorization", `Bearer ${apiKey}`);
  outgoing.set("content-type", outgoing.get("content-type") ?? "application/json");
  outgoing.set("content-length", String(contentLength));
  outgoing.set("accept-encoding", "identity");
  return outgoing;
}

function isAllowedForwardHeader(lower: string, additionalHeaders: ReadonlySet<string>): boolean {
  return DEFAULT_FORWARD_REQUEST_HEADERS.has(lower) ||
    lower.startsWith("openai-") ||
    lower.startsWith("x-stainless-") ||
    additionalHeaders.has(lower);
}

function isPrivateProxyHeader(lower: string): boolean {
  return PRIVATE_PROXY_HEADERS.has(lower) ||
    lower.startsWith("cf-access-") ||
    lower.startsWith("x-amzn-oidc-") ||
    lower.startsWith("x-auth-request-") ||
    lower.startsWith("x-envoy-") ||
    lower.startsWith("x-forwarded-") ||
    lower.startsWith("x-goog-authenticated-user-") ||
    lower === "x-goog-iap-jwt-assertion" ||
    lower.startsWith("x-ms-client-principal-") ||
    lower.startsWith("x-ms-token-") ||
    lower.startsWith("sec-");
}

function normalizeForwardHeaderName(value: string): string {
  const lower = value.trim().toLowerCase();
  if (!lower || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(lower)) {
    throw new Error("forwardHeaders entries must be exact HTTP header names.");
  }
  if (
    HOP_BY_HOP.has(lower) ||
    lower.startsWith("x-ctxprof-") ||
    isPrivateProxyHeader(lower) ||
    lower === "accept-encoding" ||
    lower === "content-encoding" ||
    lower === "content-length" ||
    lower === "set-cookie"
  ) {
    throw new Error(`Refusing to opt in unsafe forwarded header: ${lower}.`);
  }
  return lower;
}

function copyResponseHeaders(headers: IncomingHttpHeaders, response: ServerResponse): void {
  const connectionHeaders = new Set(
    (protocolHeaderValue(headers.connection) ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !HOP_BY_HOP.has(lower) &&
      !connectionHeaders.has(lower) &&
      lower !== "set-cookie" &&
      value !== undefined
    ) {
      response.setHeader(name, value);
    }
  }
  response.setHeader("x-ctxprof-proxy", "1");
}

function openUpstream(url: URL, headers: Headers, body: Buffer, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers: Object.fromEntries(headers.entries()),
      signal,
    }, resolve);
    request.once("error", reject);
    request.end(body);
  });
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeWithBackpressure(response: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (response.destroyed) return false;
  if (response.write(chunk)) return true;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
  return !response.destroyed;
}

function makeUpstreamUrl(upstream: string, requestUrl: URL): URL {
  const base = new URL(upstream.endsWith("/") ? upstream : `${upstream}/`);
  let requestPath = requestUrl.pathname.replace(/^\//, "");
  const basePath = base.pathname.replace(/\/+$/g, "");
  if ((basePath === "/v1" || basePath.endsWith("/v1")) && requestPath.startsWith("v1/")) {
    requestPath = requestPath.slice(3);
  }
  const target = new URL(requestPath, base);
  target.search = requestUrl.search;
  return target;
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function requestBoundaryError(request: IncomingMessage, options: ResolvedServerOptions): string | null {
  const hostHeader = protocolHeaderValue(request.headers.host);
  if (!hostHeader) return "A valid Host header is required.";
  const requestHostname = hostnameFromAuthority(hostHeader);
  if (!requestHostname) return "The Host header is invalid.";
  if (!isAllowedRequestHostname(requestHostname, request, options)) {
    return isLoopback(options.host)
      ? "Loopback mode only accepts localhost or explicitly allowed Host headers."
      : "The Host header is not allowed. Use allowedHosts for an exact reverse-proxy hostname.";
  }

  const originHeader = protocolHeaderValue(request.headers.origin);
  if (!originHeader) return null;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return "The Origin header is invalid.";
  }
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    (origin.pathname !== "/" && origin.pathname !== "") ||
    origin.search ||
    origin.hash
  ) {
    return "The Origin header is invalid.";
  }
  const requestAuthority = normalizedAuthority(hostHeader, origin.protocol);
  if (!requestAuthority || requestAuthority !== origin.host.toLowerCase()) {
    return "Cross-origin browser requests are not allowed.";
  }
  return null;
}

function isAllowedRequestHostname(
  requestHostname: string,
  request: IncomingMessage,
  options: ResolvedServerOptions,
): boolean {
  if (isLoopback(requestHostname) || options.allowedHostnames.has(requestHostname)) return true;
  if (isLoopback(options.host)) return false;
  const localAddress = request.socket.localAddress?.replace(/^\[|\]$/g, "").toLowerCase();
  if (localAddress && requestHostname === localAddress) return true;
  const boundHostname = options.host.replace(/^\[|\]$/g, "").toLowerCase();
  return !isWildcardBind(boundHostname) && requestHostname === boundHostname;
}

function normalizeAllowedHostname(value: string): string {
  const trimmed = value.trim();
  const hasExplicitPort = trimmed.startsWith("[")
    ? !trimmed.endsWith("]")
    : trimmed.includes(":");
  if (
    !trimmed ||
    hasExplicitPort ||
    trimmed.includes("*") ||
    trimmed.includes(",") ||
    /[\s/@]/.test(trimmed)
  ) {
    throw new Error("allowedHosts entries must be exact hostnames without a scheme, port, path, or wildcard.");
  }
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) throw new Error("invalid");
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new Error("allowedHosts entries must be exact hostnames without a scheme, port, path, or wildcard.");
  }
}

function isWildcardBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

function hostnameFromAuthority(authority: string): string | null {
  if (authority.includes(",") || /[\s/@]/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizedAuthority(authority: string, protocol: string): string | null {
  if (authority.includes(",") || /[\s/@]/.test(authority)) return null;
  try {
    const parsed = new URL(`${protocol}//${authority}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

function isLoopback(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return normalized.startsWith("::ffff:127.");
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return protocolHeaderValue(value)?.slice(0, 120);
}

function protocolHeaderValue(value: string | string[] | undefined): string | undefined {
  const selected = Array.isArray(value) ? value.join(", ") : value;
  return selected && selected.trim() ? selected.trim() : undefined;
}

function clampInteger(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value.trim() === "") return fallback;
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeHeaderField(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function validateUpstream(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Upstream must be a valid http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Upstream URLs must not contain credentials.");
  }
}

class BodyTooLargeError extends Error {}
