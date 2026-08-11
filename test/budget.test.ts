import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
