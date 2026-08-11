import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDemoRuns } from "../src/demo.js";
import { importFile } from "../src/importer.js";
import { isProfileRun } from "../src/store.js";

const fixtures = path.resolve("test/fixtures");

test("imports wrapped JSON exchanges", async () => {
  const values = await importFile(path.join(fixtures, "chat-baseline.json"));
  assert.equal(values.length, 1);
  assert.equal(values[0]?.run.promptVersion, "support-v1");
  assert.equal(values[0]?.run.totals.providerInputTokens, 220);
  assert.equal(values[0]?.run.capturedAt, "2026-08-11T10:00:00.000Z");
});

test("imports OpenAI traffic from HAR without headers", async () => {
  const values = await importFile(path.join(fixtures, "sample.har"), { captureMode: "none" });
  assert.equal(values.length, 1);
  assert.equal(values[0]?.run.model, "gpt-5.6-luna");
  assert.equal(values[0]?.run.endpoint, "/v1/chat/completions");
  assert.equal(values[0]?.run.totals.providerInputTokens, 20);
  assert.equal(values[0]?.run.exchange.request, null);
});

test("re-redacts normalized runs and honors metadata-only import", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-normalized-import-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const run = createDemoRuns()[0]!;
  run.label = "sk-abcdefghijklmnopqrstuvwxyz";
  run.exchange.request = { api_key: "sk-should-not-survive-normalized-import" };
  run.components[0]!.preview = "private component preview";
  const input = path.join(directory, "run.json");
  await writeFile(input, JSON.stringify(run), "utf8");

  const redacted = await importFile(input);
  assert.doesNotMatch(JSON.stringify(redacted), /sk-should-not-survive/);
  assert.equal(redacted[0]?.run.label, "[REDACTED]");

  const metadataOnly = await importFile(input, { captureMode: "none" });
  assert.equal(metadataOnly[0]?.run.exchange.request, null);
  assert.equal(metadataOnly[0]?.run.exchange.captureMode, "none");
  assert.ok(metadataOnly[0]?.run.components.every((component) => component.preview === null));
});

test("applies normalized-run label, prompt-version, and model overrides with consistent pricing", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-normalized-overrides-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "run.json");
  await writeFile(input, JSON.stringify(createDemoRuns()[0]), "utf8");
  const pricing = [{
    model: "provider/model-v2",
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 7,
    contextWindow: 200_000,
    source: "https://example.invalid/pricing",
    checkedAt: "2026-08-12",
  }];

  const imported = await importFile(input, {
    label: "refund agent",
    promptVersion: "candidate-12",
    model: "provider/model-v2",
    pricing,
  });
  const run = imported[0]?.run;
  assert.ok(run);
  assert.equal(run.label, "refund agent");
  assert.equal(run.promptVersion, "candidate-12");
  assert.equal(run.model, "provider/model-v2");
  assert.equal(run.pricing?.model, "provider/model-v2");
  assert.ok(run.totals.estimatedTotalCostUsd !== null);
  assert.equal(isProfileRun(run), true);

  const unknown = (await importFile(input, { model: "provider/unknown-model" }))[0]?.run;
  assert.equal(unknown?.pricing, null);
  assert.equal(unknown?.totals.estimatedTotalCostUsd, null);
  assert.equal(unknown?.warnings.some((warning) => warning.code === "unknown-pricing"), true);
});

test("rejects malformed normalized runs instead of treating missing metrics as zero", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-invalid-run-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "forged.json");
  await writeFile(input, JSON.stringify({
    schemaVersion: 1,
    id: "forged",
    model: "gpt-5",
    components: [{ kind: "system" }],
    totals: {},
    warnings: [],
    exchange: { request: null, response: null, captureMode: "none", truncated: false },
  }), "utf8");
  await assert.rejects(() => importFile(input), /Invalid ProfileRun schema/);
});

test("rejects invalid wrapper and HAR status or duration metadata", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-invalid-metadata-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, metadata, message] of [
    ["negative-status", { status: -1 }, /status/],
    ["fractional-status", { status: 200.5 }, /status/],
    ["negative-duration", { duration_ms: -5 }, /duration_ms/],
  ] as const) {
    const input = path.join(directory, `${name}.json`);
    await writeFile(input, JSON.stringify({
      request: { model: "custom", messages: [] },
      response: null,
      ...metadata,
    }), "utf8");
    await assert.rejects(() => importFile(input), message);
  }

  const har = path.join(directory, "invalid.har");
  await writeFile(har, JSON.stringify({
    log: {
      entries: [{
        startedDateTime: "2026-08-12T00:00:00.000Z",
        time: -5,
        request: {
          url: "https://api.example.test/v1/chat/completions",
          postData: { text: JSON.stringify({ model: "custom", messages: [] }) },
        },
        response: { status: -1, content: { text: "{}" } },
      }],
    },
  }), "utf8");
  await assert.rejects(() => importFile(har), /HAR response\.status|HAR entry\.time/);
});

test("rejects every input document that contains no supported records", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-empty-documents-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const documents = [
    ["empty.jsonl", ""],
    ["empty-array.json", "[]"],
    ["empty.har", JSON.stringify({ log: { entries: [] } })],
    ["unsupported.har", JSON.stringify({
      log: {
        entries: [
          {},
          { request: { url: "https://example.test", postData: {} } },
          { request: { url: "https://example.test", postData: { text: "not json" } } },
        ],
      },
    })],
  ] as const;

  for (const [name, contents] of documents) {
    const input = path.join(directory, name);
    await writeFile(input, contents, "utf8");
    await assert.rejects(
      () => importFile(input),
      new RegExp(`No supported records.*${name.replace(".", "\\.")}`),
    );
  }
});
