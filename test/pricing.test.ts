import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeExchange } from "../src/analyzer.js";
import { metricsForRuns } from "../src/budget.js";
import { importFile } from "../src/importer.js";
import { findPricing, loadPricingFile, MAX_PRICING_RATE_USD_PER_MILLION } from "../src/pricing.js";
import { isProfileRun, RunStore } from "../src/store.js";

test("validates custom pricing against the persisted ProfileRun contract", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-pricing-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const base = {
    model: "custom/model",
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 8,
    contextWindow: 100_000,
    source: "provider documentation",
    checkedAt: "2026-08-12",
  };
  for (const [name, replacement, message] of [
    ["fractional", { contextWindow: 10.5 }, /context window/],
    ["blank-source", { source: "   " }, /source/],
    ["blank-date", { checkedAt: "   " }, /checkedAt/],
  ] as const) {
    const file = path.join(directory, `${name}.json`);
    await writeFile(file, JSON.stringify([{ ...base, ...replacement }]), "utf8");
    await assert.rejects(() => loadPricingFile(file), message);
  }
  assert.throws(
    () => analyzeExchange(
      { model: "custom/model", messages: [] },
      null,
      { pricing: [{ ...base, contextWindow: 10.5 }] },
    ),
    /context window/,
  );

  const catalogFile = path.join(directory, "valid.json");
  await writeFile(catalogFile, JSON.stringify([{ ...base, model: " custom/model ", source: " docs " }]), "utf8");
  const catalog = await loadPricingFile(catalogFile);
  assert.equal(catalog[0]?.model, "custom/model");
  assert.equal(catalog[0]?.source, "docs");
  const run = analyzeExchange(
    { model: "custom/model", messages: [{ role: "user", content: "Hello" }] },
    { usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { pricing: catalog },
  );
  assert.equal(isProfileRun(run), true);

  const store = new RunStore(path.join(directory, "store"));
  await store.init();
  await store.append(run);
  assert.equal((await store.list()).length, 1);
  const runFile = path.join(directory, "run.json");
  await writeFile(runFile, JSON.stringify(run), "utf8");
  const imported = await importFile(runFile);
  assert.equal(Object.keys(metricsForRuns(imported)).length, 1);
});

test("inherits built-in prices only for real canonical snapshot dates", () => {
  assert.ok(findPricing("gpt-5-2026-08-12"));
  assert.ok(findPricing("gpt-5.6-terra-2026-08-12"));
  for (const model of [
    "gpt-5-20not-a-date",
    "gpt-5-2026evil",
    "gpt-5-2026-99-99",
    "gpt-5-2026-02-29",
    "gpt-5-2026-08-12-provider",
    "gpt-5-provider-2026-08-12",
  ]) {
    assert.equal(findPricing(model), null, `${model} must not inherit a built-in price`);
  }
});

test("rejects custom rates that could overflow cost calculations", () => {
  const base = {
    model: "extreme-rate",
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 1,
    contextWindow: 100_000,
    source: "provider contract",
    checkedAt: "2026-08-12",
  };
  assert.throws(
    () => analyzeExchange(
      { model: base.model, messages: [{ role: "user", content: "input" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { pricing: [{ ...base, inputPerMillionUsd: Number.MAX_VALUE }] },
    ),
    /invalid input price/,
  );
  assert.throws(
    () => analyzeExchange(
      { model: base.model, messages: [{ role: "user", content: "output" }] },
      { usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { pricing: [{ ...base, outputPerMillionUsd: Number.MAX_VALUE }] },
    ),
    /invalid output price/,
  );
  const valid = analyzeExchange(
    { model: base.model, messages: [{ role: "user", content: "expensive but finite" }] },
    { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 0 } },
    {
      pricing: [{
        ...base,
        inputPerMillionUsd: MAX_PRICING_RATE_USD_PER_MILLION,
        outputPerMillionUsd: MAX_PRICING_RATE_USD_PER_MILLION,
      }],
    },
  );
  assert.equal(isProfileRun(valid), true);
  assert.equal(Number.isFinite(valid.totals.estimatedTotalCostUsd), true);
});
