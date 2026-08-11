import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeExchange } from "../src/analyzer.js";
import { createDemoRuns } from "../src/demo.js";
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
