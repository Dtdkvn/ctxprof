import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { startServer } from "../src/server.js";
import { RunStore } from "../src/store.js";
import type { ProfileRun } from "../src/types.js";

test("passes through an OpenAI-compatible response and records it safely", async (context) => {
  const upstream = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-only");
    assert.equal(request.url, "/gateway/v1/chat/completions");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "gpt-5.6-luna",
      choices: [{ message: { role: "assistant", content: "Hello!" } }],
      usage: { prompt_tokens: 22, completion_tokens: 2, total_tokens: 24 },
    }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-server-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}/gateway/v1`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-only",
      "content-type": "application/json",
      "x-ctxprof-version": "proxy-v1",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      api_key: "sk-secret-never-store-this",
      messages: [{ role: "user", content: "Say hello" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { choices: unknown[] }).choices.length, 1);
  await captured;
  const runs = await new RunStore(directory).list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.promptVersion, "proxy-v1");
  assert.equal(runs[0]?.totals.providerInputTokens, 22);
  assert.doesNotMatch(JSON.stringify(runs), /sk-secret-never/);

  const dashboard = await fetch(proxy.url);
  assert.match(dashboard.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await dashboard.text(), /Context treemap/);
});

test("refuses a remote bind unless explicitly allowed", async () => {
  await assert.rejects(() => startServer({ host: "0.0.0.0", port: 0 }), /Refusing to bind/);
  await assert.rejects(
    () => startServer({ port: 0, upstream: "https://user:password@example.com" }),
    /must not contain credentials/,
  );
});

test("passes through SSE and captures the final usage event", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ model: "gpt-5.6-luna", choices: [{ delta: { content: "Hi" } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ model: "gpt-5.6-luna", choices: [], usage: { prompt_tokens: 31, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-sse-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.match(await response.text(), /\[DONE\]/);
  await captured;
  const runs = await new RunStore(directory).list();
  assert.equal(runs[0]?.totals.providerInputTokens, 31);
  assert.equal(runs[0]?.totals.outputTokens, 3);
});

test("captures nested usage from a Responses API stream", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.created", response: { model: "gpt-5.6-luna" } })}\n\n`);
    response.end(`data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "gpt-5.6-luna",
        usage: { input_tokens: 47, output_tokens: 5, total_tokens: 52 },
      },
    })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-responses-sse-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());
  const response = await fetch(`${proxy.url}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: "Hello" }),
  });
  assert.match(await response.text(), /response\.completed/);
  await captured;
  const runs = await new RunStore(directory).list();
  assert.equal(runs[0]?.model, "gpt-5.6-luna");
  assert.equal(runs[0]?.totals.providerInputTokens, 47);
  assert.equal(runs[0]?.totals.outputTokens, 5);
});

test("does not turn a capture failure into an upstream failure", async (context) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "gpt-5.6-luna",
      choices: [{ message: { role: "assistant", content: "Still delivered" } }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-failure-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let attempts = 0;
  let attemptedResolve!: () => void;
  const attempted = new Promise<void>((resolve) => { attemptedResolve = resolve; });
  class FailingStore extends RunStore {
    override async append(_run: ProfileRun): Promise<void> {
      attempts += 1;
      attemptedResolve();
      throw new Error("simulated capture failure");
    }
  }
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new FailingStore(directory),
    quiet: true,
  });
  context.after(() => proxy.close());
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { choices: unknown[] }).choices.length, 1);
  await attempted;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 1);
  assert.equal((await fetch(`${proxy.url}/healthz`)).status, 200);
});

test("enforces loopback Host and same-origin browser boundaries with explicit remote behavior", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const local = await startServer({ port: 0, store: new RunStore(directory), quiet: true });
  context.after(() => local.close());

  const rebinding = await rawRequest(`${local.url}/api/runs`, {
    headers: { host: "attacker.example" },
  });
  assert.equal(rebinding.status, 403);

  const crossOrigin = await rawRequest(`${local.url}/api/runs`, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(crossOrigin.status, 403);

  const sameOrigin = await rawRequest(`${local.url}/api/runs`, {
    headers: { origin: local.url },
  });
  assert.equal(sameOrigin.status, 200);

  const remoteDirectory = await mkdtemp(path.join(tmpdir(), "ctxprof-remote-boundary-"));
  context.after(() => rm(remoteDirectory, { recursive: true, force: true }));
  const remote = await startServer({
    host: "0.0.0.0",
    port: 0,
    allowRemote: true,
    store: new RunStore(remoteDirectory),
    quiet: true,
  });
  context.after(() => remote.close());
  const remoteUrl = `http://127.0.0.1:${remote.port}`;
  assert.equal((await rawRequest(`${remoteUrl}/healthz`)).status, 200);
  const arbitraryRemoteHost = await rawRequest(`${remoteUrl}/api/runs`, {
    headers: { host: "attacker.example" },
  });
  assert.equal(arbitraryRemoteHost.status, 403);

  const allowedDirectory = await mkdtemp(path.join(tmpdir(), "ctxprof-allowed-host-"));
  context.after(() => rm(allowedDirectory, { recursive: true, force: true }));
  const allowedRemote = await startServer({
    host: "0.0.0.0",
    port: 0,
    allowRemote: true,
    allowedHosts: ["ctxprof.example"],
    store: new RunStore(allowedDirectory),
    quiet: true,
  });
  context.after(() => allowedRemote.close());
  const allowedRemoteUrl = `http://127.0.0.1:${allowedRemote.port}`;
  const trustedRemote = await rawRequest(`${allowedRemoteUrl}/healthz`, {
    headers: { host: "ctxprof.example", origin: "https://ctxprof.example" },
  });
  assert.equal(trustedRemote.status, 200);
  const untrustedRemoteOrigin = await rawRequest(`${allowedRemoteUrl}/healthz`, {
    headers: { host: "ctxprof.example", origin: "https://attacker.example" },
  });
  assert.equal(untrustedRemoteOrigin.status, 403);
  await assert.rejects(
    () => startServer({ port: 0, allowedHosts: ["*.example.com"] }),
    /allowedHosts entries/,
  );
  await assert.rejects(
    () => startServer({ port: 0, allowedHosts: ["ctxprof.example:80"] }),
    /allowedHosts entries/,
  );
});

test("rejects non-JSON proxy requests before contacting upstream", async (context) => {
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1;
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-content-type-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
  });
  context.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
  });
  assert.equal(response.status, 415);
  assert.equal(upstreamRequests, 0);
});

test("strips forwarding and identity-proxy headers before upstream", async (context) => {
  const longConnection = `${Array.from({ length: 30 }, (_value, index) => `x-hop-${index}`).join(", ")}, x-internal-hop`;
  let observedHeadersResolve!: (headers: IncomingHttpHeaders) => void;
  const observedHeaders = new Promise<IncomingHttpHeaders>((resolve) => { observedHeadersResolve = resolve; });
  const upstream = createServer((request, response) => {
    observedHeadersResolve(request.headers);
    response.writeHead(200, {
      "content-type": "application/json",
      connection: longConnection,
      "x-internal-hop": "must-not-be-forwarded",
    });
    response.end(JSON.stringify({
      model: "gpt-5.6-luna",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-headers-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: proxy.url,
      referer: `${proxy.url}/dashboard`,
      forwarded: "for=203.0.113.7;host=attacker.example",
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
      "x-forwarded-access-token": "synthetic-forward-token",
      "cf-access-jwt-assertion": "synthetic-cf-token",
      "x-amzn-oidc-data": "synthetic-alb-identity",
      "x-auth-request-user": "private@example.test",
      "x-goog-authenticated-user-email": "accounts.google.com:private@example.test",
      "x-goog-iap-jwt-assertion": "synthetic-iap-token",
      "x-real-ip": "203.0.113.7",
      "openai-organization": "org_test",
    },
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-internal-hop"), null);
  const headers = await observedHeaders;
  for (const name of [
    "origin",
    "referer",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-access-token",
    "cf-access-jwt-assertion",
    "x-amzn-oidc-data",
    "x-auth-request-user",
    "x-goog-authenticated-user-email",
    "x-goog-iap-jwt-assertion",
    "x-real-ip",
  ]) {
    assert.equal(headers[name], undefined, `${name} must not cross the proxy boundary`);
  }
  assert.equal(headers["openai-organization"], "org_test");
  assert.equal(headers["accept-encoding"], "identity");
  await captured;
});

test("preserves unknown response encodings and decodes supported encodings for capture", async (context) => {
  const zstdBody = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
  const gzipPayload = Buffer.from(JSON.stringify({
    model: "gpt-5.6-luna",
    choices: [{ message: { role: "assistant", content: "compressed" } }],
    usage: { prompt_tokens: 19, completion_tokens: 4 },
  }));
  const gzipBody = gzipSync(gzipPayload);
  const upstream = createServer((request, response) => {
    assert.equal(request.headers["accept-encoding"], "identity");
    if (request.url === "/v1/zstd") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-encoding": "zstd",
        "content-length": zstdBody.length,
      });
      response.end(zstdBody);
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": gzipBody.length,
    });
    response.end(gzipBody);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-encoding-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let captureCount = 0;
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => {
      captureCount += 1;
      if (captureCount === 2) capturedResolve();
    },
  });
  context.after(() => proxy.close());

  const zstd = await rawRequest(`${proxy.url}/v1/zstd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(zstd.status, 200);
  assert.equal(zstd.headers["content-encoding"], "zstd");
  assert.deepEqual(zstd.body, zstdBody);

  const gzip = await rawRequest(`${proxy.url}/v1/compressed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ model: "gpt-5.6-luna", messages: [] })),
  });
  assert.equal(gzip.headers["content-encoding"], "gzip");
  assert.deepEqual(gunzipSync(gzip.body), gzipPayload);
  await captured;
  const runs = await new RunStore(directory).list();
  const zstdRun = runs.find((run) => run.endpoint === "/v1/zstd");
  const compressedRun = runs.find((run) => run.endpoint === "/v1/compressed");
  assert.equal(zstdRun?.exchange.truncated, true);
  assert.ok((zstdRun?.totals.outputTokens ?? 0) > 0);
  assert.equal(zstdRun?.warnings.some((warning) => warning.code === "truncated-response"), true);
  assert.equal(compressedRun?.totals.providerInputTokens, 19);
  assert.equal(compressedRun?.totals.outputTokens, 4);
});

test("retains final usage beyond the bounded response capture window", async (context) => {
  const filler = "x".repeat(5 * 1024 * 1024 + 512);
  const upstream = createServer((request, response) => {
    if (request.url === "/v1/large-stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ model: "gpt-5.6-luna", delta: filler })}\n\n`);
      response.end(`data: ${JSON.stringify({ usage: { prompt_tokens: 47, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      model: "gpt-5.6-luna",
      payload: filler,
      usage: request.url === "/v1/negative-usage"
        ? { prompt_tokens: -53, completion_tokens: -7 }
        : { prompt_tokens: 53, completion_tokens: 7 },
    }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-large-response-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let captureCount = 0;
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => {
      captureCount += 1;
      if (captureCount === 3) capturedResolve();
    },
  });
  context.after(() => proxy.close());

  for (const endpoint of ["large-stream", "large-json", "negative-usage"]) {
    const response = await fetch(`${proxy.url}/v1/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 5 * 1024 * 1024);
  }
  await captured;
  const runs = await new RunStore(directory).list();
  const streamRun = runs.find((run) => run.endpoint === "/v1/large-stream");
  const jsonRun = runs.find((run) => run.endpoint === "/v1/large-json");
  const negativeUsageRun = runs.find((run) => run.endpoint === "/v1/negative-usage");
  assert.equal(streamRun?.totals.providerInputTokens, 47);
  assert.equal(streamRun?.totals.outputTokens, 5);
  assert.equal(jsonRun?.totals.providerInputTokens, 53);
  assert.equal(jsonRun?.totals.outputTokens, 7);
  assert.equal(negativeUsageRun?.totals.providerInputTokens, null);
  assert.ok((negativeUsageRun?.totals.outputTokens ?? 0) > 0);
  for (const run of [streamRun, jsonRun]) {
    assert.equal(run?.exchange.truncated, true);
    assert.equal(run?.warnings.some((warning) => warning.code === "truncated-response"), true);
  }
  assert.equal(negativeUsageRun?.warnings.some((warning) => warning.code === "truncated-response"), true);
});

test("aborts the upstream socket when the downstream client disconnects", async (context) => {
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
  const upstream = createServer((request) => {
    startedResolve();
    request.socket.once("close", () => closedResolve());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-abort-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    upstreamTimeoutMs: 5_000,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());

  const client = httpRequest(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  client.on("error", () => undefined);
  client.end(JSON.stringify({ model: "gpt-5.6-luna", messages: [] }));
  await started;
  client.destroy();
  await withTimeout(closed, 1_000, "upstream socket remained open after downstream disconnect");
  await captured;
});

test("enforces the configurable upstream timeout and closes the upstream socket", async (context) => {
  let closedResolve!: () => void;
  const closed = new Promise<void>((resolve) => { closedResolve = resolve; });
  const upstream = createServer((request) => {
    request.socket.once("close", () => closedResolve());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-timeout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let capturedResolve!: () => void;
  const captured = new Promise<void>((resolve) => { capturedResolve = resolve; });
  const proxy = await startServer({
    port: 0,
    upstream: `http://127.0.0.1:${address.port}`,
    upstreamTimeoutMs: 40,
    store: new RunStore(directory),
    quiet: true,
    onRun: () => capturedResolve(),
  });
  context.after(() => proxy.close());

  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [] }),
  });
  assert.equal(response.status, 504);
  assert.match(await response.text(), /timed out/i);
  await withTimeout(closed, 1_000, "upstream socket remained open after timeout");
  await captured;
  await assert.rejects(
    () => startServer({ port: 0, upstreamTimeoutMs: 0 }),
    /upstreamTimeoutMs/,
  );
});

interface RawRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function rawRequest(url: string, options: RawRequestOptions = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
