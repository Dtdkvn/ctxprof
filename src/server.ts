import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { analyzeExchange } from "./analyzer.js";
import { compareVersions } from "./compare.js";
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
  "content-length",
  "content-encoding",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 8787;
  if (!isLoopback(host) && !options.allowRemote) {
    throw new Error(
      `Refusing to bind to ${host}. Ctxprof contains prompt data; pass --allow-remote only behind a trusted network boundary.`,
    );
  }
  if (options.upstream) validateUpstream(options.upstream);
  const store = options.store ?? new RunStore();
  await store.init();
  const server = createServer((request, response) => {
    void route(request, response, { ...options, host, port: requestedPort, store }).catch((error) => {
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
  const displayHost = host === "::1" ? "[::1]" : host;
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
  options: Required<Pick<ServerOptions, "host" | "port" | "store">> & ServerOptions,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://ctxprof.local");
  if (request.method === "GET" && requestUrl.pathname === "/") {
    html(response, 200, renderDashboard([], { live: true, title: "Ctxprof · live context profile" }));
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
  options: Required<Pick<ServerOptions, "store">> & ServerOptions,
): Promise<void> {
  if (request.method !== "POST") {
    json(response, 405, { error: "Ctxprof currently profiles JSON POST requests only." });
    return;
  }
  let rawRequest: Buffer;
  try {
    rawRequest = await readBody(request, 20 * 1024 * 1024);
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
  const headers = forwardRequestHeaders(request.headers, options.apiKey);
  const label = headerValue(request.headers["x-ctxprof-label"]) ?? options.defaultLabel;
  const promptVersion =
    headerValue(request.headers["x-ctxprof-version"]) ?? options.defaultPromptVersion;
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: rawRequest.toString("utf8"),
      redirect: "manual",
    });
    copyResponseHeaders(upstreamResponse.headers, response);
    response.statusCode = upstreamResponse.status;
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    const maxResponseCaptureBytes = 5 * 1024 * 1024;
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = Buffer.from(part.value);
        const writable = await writeWithBackpressure(response, chunk);
        if (!writable) {
          await reader.cancel();
          break;
        }
        if (capturedBytes < maxResponseCaptureBytes) {
          const remaining = maxResponseCaptureBytes - capturedBytes;
          chunks.push(chunk.subarray(0, remaining));
          capturedBytes += Math.min(chunk.length, remaining);
        }
      }
    }
    if (!response.destroyed) response.end();
    const capturedResponse = parseUpstreamPayload(
      Buffer.concat(chunks).toString("utf8"),
      upstreamResponse.headers.get("content-type") ?? "",
    );
    await recordRunSafely(parsedRequest, capturedResponse, {
      endpoint: requestUrl.pathname,
      status: upstreamResponse.status,
      durationMs: Math.round(performance.now() - started),
      label,
      promptVersion,
      options,
    });
  } catch (error) {
    const detail = safeError(error);
    if (!response.headersSent) json(response, 502, { error: "Upstream request failed", detail });
    else response.end();
    await recordRunSafely(parsedRequest, { error: detail }, {
      endpoint: requestUrl.pathname,
      status: 502,
      durationMs: Math.round(performance.now() - started),
      label,
      promptVersion,
      options,
    });
  }
}

interface RecordOptions {
  endpoint: string;
  status: number;
  durationMs: number;
  label: string | undefined;
  promptVersion: string | undefined;
  options: Required<Pick<ServerOptions, "store">> & ServerOptions;
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
  await record.options.store.append(run);
  await record.options.onRun?.(run);
  if (!record.options.quiet) {
    const tokens = run.totals.providerInputTokens ?? run.totals.estimatedInputTokens;
    process.stdout.write(
      `captured ${run.model} · ${tokens.toLocaleString()} input tok · ${run.durationMs ?? 0} ms · ${run.promptVersion}\n`,
    );
  }
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
    const events: unknown[] = [];
    for (const line of value.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload) as unknown);
      } catch {
        // Ignore incomplete final stream chunks.
      }
    }
    const withUsage = [...events].reverse().find((event) => {
      if (!isRecord(event)) return false;
      return isRecord(event.usage) || (isRecord(event.response) && isRecord(event.response.usage));
    });
    if (withUsage && isRecord(withUsage)) {
      const usage = isRecord(withUsage.usage)
        ? withUsage.usage
        : isRecord(withUsage.response) && isRecord(withUsage.response.usage)
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
        usage,
        ...(model ? { model } : {}),
      };
    }
    return { events };
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: redactText(value) };
  }
}

function forwardRequestHeaders(headers: IncomingHttpHeaders, apiKey: string | undefined): Headers {
  const outgoing = new Headers();
  for (const [name, rawValue] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower.startsWith("x-ctxprof-")) continue;
    if (rawValue !== undefined) outgoing.set(name, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue);
  }
  if (!outgoing.has("authorization") && apiKey) outgoing.set("authorization", `Bearer ${apiKey}`);
  outgoing.set("content-type", outgoing.get("content-type") ?? "application/json");
  return outgoing;
}

function copyResponseHeaders(headers: Headers, response: ServerResponse): void {
  for (const [name, value] of headers.entries()) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
      response.setHeader(name, value);
    }
  }
  response.setHeader("x-ctxprof-proxy", "1");
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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const selected = Array.isArray(value) ? value[0] : value;
  return selected && selected.trim() ? selected.trim().slice(0, 120) : undefined;
}

function clampInteger(value: string | null, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
