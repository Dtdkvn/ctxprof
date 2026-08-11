import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeExchange } from "../src/analyzer.js";
import {
  evaluateBudget,
  makeBaseline,
  metricsForRuns,
  readBaseline,
  readBudgetConfig,
  writeBaseline,
} from "../src/budget.js";
import { importFile } from "../src/importer.js";

test("passes an unchanged context baseline", async () => {
  const runs = await importFile(path.resolve("test/fixtures/chat-baseline.json"), { captureMode: "none" });
  const cases = metricsForRuns(runs);
  const result = evaluateBudget(
    cases,
    { limits: { inputTokens: 300 }, regressions: { inputTokensPercent: 0, componentPercent: 0 } },
    makeBaseline(cases),
  );
  assert.equal(result.passed, true);
});

test("accepts the canonical price for a case-insensitive model identifier", () => {
  const run = analyzeExchange(
    { model: "GPT-5", messages: [{ role: "user", content: "Hello" }] },
    { usage: { prompt_tokens: 8, completion_tokens: 2 } },
  );
  const cases = metricsForRuns([{ name: "case-insensitive-model", run }]);
  assert.equal(cases["case-insensitive-model"]?.estimatedCostUsd, run.totals.estimatedTotalCostUsd);
});

test("rejects ambiguous duplicate case identities instead of assigning order-dependent suffixes", () => {
  const run = analyzeExchange({ model: "custom", messages: [{ role: "user", content: "same" }] });
  assert.throws(
    () => metricsForRuns([{ name: "same.json", run }, { name: "same.json", run }]),
    /Duplicate context budget case name/,
  );
});

test("validates configuration and creates baseline parent directories", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-budget-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const invalid = path.join(directory, "invalid.json");
  await writeFile(invalid, JSON.stringify({ limits: { inputTokens: "many" } }), "utf8");
  await assert.rejects(() => readBudgetConfig(invalid), /non-negative number/);
  const baselinePath = path.join(directory, "nested", "baseline.json");
  await writeBaseline(baselinePath, makeBaseline({}));
  assert.match(await readFile(baselinePath, "utf8"), /schemaVersion/);
  const malformedBaseline = path.join(directory, "malformed-baseline.json");
  await writeFile(malformedBaseline, JSON.stringify({ schemaVersion: 1, generatedAt: "now", cases: { bad: {} } }), "utf8");
  await assert.rejects(() => readBaseline(malformedBaseline), /components must be an object/);
});

test("fails absolute and component regressions with actionable violations", async () => {
  const baselineRuns = await importFile(path.resolve("test/fixtures/chat-baseline.json"), { captureMode: "none" });
  const regressionRuns = await importFile(path.resolve("test/fixtures/chat-regression.json"), { captureMode: "none" });
  regressionRuns[0]!.name = baselineRuns[0]!.name;
  const result = evaluateBudget(
    metricsForRuns(regressionRuns),
    { limits: { inputTokens: 500 }, regressions: { inputTokensPercent: 5, componentPercent: 10 } },
    makeBaseline(metricsForRuns(baselineRuns)),
  );
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((violation) => violation.metric === "inputTokens"));
  assert.ok(result.violations.some((violation) => violation.metric.includes("component regression")));
});

test("requires new regression cases to be acknowledged in the baseline", async () => {
  const runs = await importFile(path.resolve("test/fixtures/chat-baseline.json"), { captureMode: "none" });
  const cases = metricsForRuns(runs);
  const result = evaluateBudget(
    cases,
    { regressions: { inputTokensPercent: 5 } },
    makeBaseline({}),
  );
  assert.equal(result.passed, false);
  assert.match(result.violations[0]?.message ?? "", /missing from the committed baseline/);
});

test("compares removed baseline cases only when regression policy is enabled", () => {
  const prior = makeBaseline({
    removed: {
      inputTokens: 10,
      totalTokens: 10,
      estimatedCostUsd: null,
      warnings: 0,
      components: { system: 10, developer: 0, tools: 0, message: 0, tool_result: 0, other: 0 },
    },
  });
  assert.equal(evaluateBudget({}, { limits: { inputTokens: 100 } }, prior).passed, true);
  const regression = evaluateBudget({}, { regressions: { inputTokensPercent: 0 } }, prior);
  assert.equal(regression.passed, false);
  assert.match(regression.violations[0]?.message ?? "", /missing from current inputs/);
});

test("fails closed when a library caller supplies non-finite run metrics", () => {
  const malformed = {
    name: "forged.json",
    run: {
      components: [{ kind: "system", allocatedInputTokens: Number.NaN }],
      warnings: [],
      totals: {
        providerInputTokens: null,
        estimatedInputTokens: Number.NaN,
        totalTokens: Number.NaN,
        estimatedTotalCostUsd: null,
      },
    },
  };
  assert.throws(
    () => metricsForRuns([malformed as never]),
    /Invalid ProfileRun “forged\.json”: metrics are not finite and internally consistent/,
  );
});

test("keeps aggregated high-cardinality tools inside the tools budget", () => {
  const run = analyzeExchange(
    {
      model: "custom",
      messages: [{ role: "user", content: "small" }],
      tools: Array.from({ length: 20_000 }, () => null),
    },
    null,
    { captureMode: "none" },
  );
  const cases = metricsForRuns([{ name: "many-tools", run }]);
  assert.equal(cases["many-tools"]?.components.tools, 100_000);
  assert.equal(cases["many-tools"]?.components.other, 0);
  const result = evaluateBudget(cases, { limits: { components: { tools: 5_000 } } }, null);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((violation) => violation.metric === "components.tools"));
});

test("rejects forged normalized costs before a budget can treat them as zero", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-forged-cost-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const run = analyzeExchange(
    { model: "priced-model", messages: [{ role: "user", content: "budget me" }] },
    { usage: { prompt_tokens: 1_000, completion_tokens: 500 } },
    {
      pricing: [{
        model: "priced-model",
        inputPerMillionUsd: 10,
        outputPerMillionUsd: 20,
        contextWindow: 10_000,
        source: "https://example.invalid/pricing",
        checkedAt: "2026-08-12",
      }],
    },
  );
  run.totals.estimatedInputCostUsd = 0;
  run.totals.estimatedOutputCostUsd = 0;
  run.totals.estimatedTotalCostUsd = 0;
  for (const component of run.components) component.estimatedCostUsd = 0;
  const input = path.join(directory, "forged-cost.json");
  await writeFile(input, JSON.stringify(run), "utf8");

  await assert.rejects(() => importFile(input), /Invalid ProfileRun schema/);
  assert.throws(
    () => metricsForRuns([{ name: "forged-cost.json", run }]),
    /not finite and internally consistent/,
  );
});
