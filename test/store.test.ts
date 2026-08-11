import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeExchange } from "../src/analyzer.js";
import { createDemoRuns } from "../src/demo.js";
import { MAX_PROFILE_RUN_BYTES } from "../src/limits.js";
import { RunStore } from "../src/store.js";

test("stores JSONL captures and tolerates an interrupted final record", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  await store.appendMany(createDemoRuns());
  await appendFile(store.runsFile, "{interrupted", "utf8");
  const runs = await store.list();
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.promptVersion, "support-v2");
  assert.ok((await store.sizeBytes()) > 0);
});

test("append and appendMany repair an interrupted final record before writing", async (context) => {
  for (const method of ["append", "appendMany"] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), `ctxprof-store-${method}-tail-`));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const store = new RunStore(directory);
    const [first, second] = createDemoRuns();
    assert.ok(first && second);
    await store.append(first);
    await appendFile(store.runsFile, '{"schemaVersion":1', "utf8");

    if (method === "append") await store.append(second);
    else await store.appendMany([second]);

    assert.deepEqual((await store.list()).map((run) => run.id), [second.id, first.id]);
  }
});

test("store revisions are stable until queued storage changes", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-revision-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  assert.equal(await store.revision(), "0-0");
  assert.equal(await store.revision(), "0-0");

  const [first, second] = createDemoRuns();
  assert.ok(first && second);
  await store.append(first);
  const firstRevision = await store.revision();
  assert.equal(await store.revision(), firstRevision);
  await store.append(second);
  assert.notEqual(await store.revision(), firstRevision);
});

test("store list and append enforce numeric and serialized-run bounds", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-bounds-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  await store.append(createDemoRuns()[0]!);
  assert.deepEqual(await store.list(0), []);
  await assert.rejects(() => store.list(1.5), /non-negative safe integer/);

  const oversized = createDemoRuns()[0]!;
  oversized.exchange.request = "x".repeat(MAX_PROFILE_RUN_BYTES);
  await assert.rejects(() => store.append(oversized), /Refusing to store a .*ProfileRun/);
});

test("recovers the write queue after a failed append", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-recovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  await store.init();
  await mkdir(store.runsFile);
  const run = analyzeExchange({ model: "gpt-5.6-luna", input: "queue recovery" });
  await assert.rejects(() => store.append(run));
  await rm(store.runsFile, { recursive: true });
  await store.append(run);
  assert.equal((await store.list()).length, 1);
});

test("rejects malformed or non-run records before the interrupted final tail", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-integrity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RunStore(directory);
  await store.init();
  const [first, second] = createDemoRuns();
  assert.ok(first && second);
  await writeFile(store.runsFile, `${JSON.stringify(first)}\n{broken\n${JSON.stringify(second)}\n`, "utf8");
  await store.append(first);
  await assert.rejects(() => store.list(), /runs\.jsonl:2/);

  await writeFile(store.runsFile, `${JSON.stringify(first)}\n{}\n`, "utf8");
  await assert.rejects(() => store.list(), /Invalid ProfileRun.*runs\.jsonl:2/);
});
