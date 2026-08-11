import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDemoRuns } from "../src/demo.js";
import { importFile } from "../src/importer.js";

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
