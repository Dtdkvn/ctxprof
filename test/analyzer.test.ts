import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { analyzeExchange } from "../src/analyzer.js";
import { MAX_PROFILE_COMPONENTS, MAX_PROFILE_RUN_BYTES, MAX_PROFILE_WARNINGS } from "../src/limits.js";
import { isProfileRun } from "../src/store.js";

test("attributes chat context and allocates provider totals", () => {
  const run = analyzeExchange(
    {
      model: "gpt-5.6-terra",
      api_key: "sk-this-must-never-be-saved",
      messages: [
        { role: "system", content: "Keep answers short." },
        { role: "user", content: "Use Bearer secret-value-123456789 to say hello." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Look up a value.",
            parameters: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      ],
    },
    {
      choices: [{ message: { tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 12 },
    },
  );
  assert.equal(run.totals.providerInputTokens, 100);
  assert.equal(run.totals.outputTokens, 12);
  assert.equal(run.components.reduce((sum, component) => sum + component.allocatedInputTokens, 0), 100);
  assert.deepEqual(new Set(run.components.map((component) => component.kind)), new Set(["system", "message", "tools"]));
  assert.ok(run.totals.estimatedTotalCostUsd !== null);
  assert.equal((run.exchange.request as Record<string, unknown>).api_key, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(run.exchange), /secret-value|sk-this/);
  assert.equal(run.warnings.some((warning) => warning.code === "unused-tool"), false);
});

test("profiles Responses API instructions, tool outputs, and schemas", () => {
  const largeResult = "record,".repeat(2_000);
  const run = analyzeExchange({
    model: "custom-model",
    instructions: "Summarize the tool result.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "Find the records." }] },
      { type: "function_call_output", call_id: "call_1", output: largeResult },
    ],
    tools: [{ type: "function", name: "search", description: "Search", parameters: { type: "object" } }],
  });
  assert.ok(run.components.some((component) => component.kind === "system"));
  assert.ok(run.components.some((component) => component.kind === "tool_result"));
  assert.ok(run.warnings.some((warning) => warning.code === "large-tool-result"));
  assert.ok(run.warnings.some((warning) => warning.code === "unknown-pricing"));
});

test("supports metadata-only capture", () => {
  const run = analyzeExchange(
    { model: "gpt-5.6-luna", messages: [{ role: "user", content: "private" }] },
    null,
    { captureMode: "none" },
  );
  assert.equal(run.exchange.captureMode, "none");
  assert.equal(run.exchange.request, null);
  assert.equal(run.components[0]?.preview, null);
});

test("redacts structured component previews before serialization", () => {
  const run = analyzeExchange({
    model: "custom-model",
    messages: [
      {
        role: "user",
        content: {
          api_key: "arbitrary-sensitive-value",
          nested: { authToken: "another-sensitive-value" },
          safe: "visible",
        },
      },
    ],
  });
  assert.match(run.components[0]?.preview ?? "", /visible/);
  assert.doesNotMatch(run.components[0]?.preview ?? "", /arbitrary-sensitive|another-sensitive/);
  assert.match(run.components[0]?.preview ?? "", /\[REDACTED\]/);
});

test("preserves provider totals across many rounded components", () => {
  const run = analyzeExchange(
    {
      model: "gpt-5",
      messages: Array.from({ length: 100 }, () => ({ role: "user", content: "x" })),
    },
    { usage: { prompt_tokens: 350, completion_tokens: 0 } },
    { captureMode: "none" },
  );
  assert.equal(run.components.reduce((sum, component) => sum + component.allocatedInputTokens, 0), 350);
  assert.equal(run.totals.providerInputTokens, 350);
  const componentCost = run.components.reduce(
    (sum, component) => sum + (component.estimatedCostUsd ?? 0),
    0,
  );
  assert.ok(Math.abs(componentCost - (run.totals.estimatedInputCostUsd ?? 0)) < 1e-12);
});

test("ignores unsafe or overflowing provider token counts", () => {
  for (const unsafe of [1e20, 1e308]) {
    const run = analyzeExchange(
      { model: "gpt-5", messages: [{ role: "user", content: "Hello" }] },
      { usage: { prompt_tokens: unsafe, completion_tokens: unsafe } },
    );
    assert.equal(run.totals.providerInputTokens, null);
    assert.equal(Number.isSafeInteger(run.totals.totalTokens), true);
    assert.equal(Number.isFinite(run.totals.estimatedTotalCostUsd), true);
    assert.equal(run.warnings.some((warning) => warning.code === "invalid-provider-usage"), true);
  }
});

test("bounds adversarial component and warning amplification without losing totals", () => {
  const tools = Array.from({ length: 200_000 }, () => null);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const run = analyzeExchange(
    {
      model: "custom-model",
      messages: [{ role: "user", content: "small prompt" }],
      tools,
    },
    null,
    { captureMode: "none" },
  );
  const elapsedMs = performance.now() - started;
  const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  assert.equal(isProfileRun(run), true);
  assert.ok(run.components.length <= MAX_PROFILE_COMPONENTS);
  assert.ok(run.warnings.length <= MAX_PROFILE_WARNINGS);
  assert.equal(
    run.warnings.filter((warning) => warning.code === "analysis-truncated").length,
    1,
  );
  const toolAggregate = run.components.find((component) =>
    component.kind === "tools" && /additional tool-schema components \(aggregated\)/.test(component.label)
  );
  assert.ok(toolAggregate);
  assert.match(toolAggregate.contentHash, /^[0-9a-f]{16}$/);
  assert.equal(
    run.components
      .filter((component) => component.kind === "tools")
      .reduce((sum, component) => sum + component.estimatedTokens, 0),
    1_000_000,
    "overflow keeps every tool token attributed to the tools budget kind",
  );
  assert.equal(
    run.components
      .filter((component) => component.kind === "tools")
      .reduce((sum, component) => sum + component.bytes, 0),
    800_000,
  );
  assert.equal(
    run.components.reduce((sum, component) => sum + component.estimatedTokens, 0),
    run.totals.estimatedInputTokens,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(run), "utf8") <= MAX_PROFILE_RUN_BYTES);
  assert.ok(heapGrowth < 64 * 1024 * 1024, `analysis heap grew by ${heapGrowth} bytes`);
  assert.ok(elapsedMs < 5_000, `analysis took ${elapsedMs.toFixed(0)} ms`);
});

test("treats an existing tool result as evidence that the tool was used", () => {
  const run = analyzeExchange({
    model: "gpt-5.6-luna",
    metadata: { ctxprof: { label: "sk-abcdefghijklmnopqrstuvwxyz" } },
    messages: [
      { role: "user", content: "Look it up" },
      { role: "tool", name: "lookup", content: "done" },
    ],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  });
  assert.equal(run.warnings.some((warning) => warning.code === "unused-tool"), false);
  assert.doesNotMatch(run.label, /sk-/);
});
