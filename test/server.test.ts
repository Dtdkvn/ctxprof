import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
