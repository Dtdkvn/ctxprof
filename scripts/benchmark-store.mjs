import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { createDemoRuns } from "../dist/demo.js";
import { RunStore } from "../dist/store.js";

const count = readCount(process.argv[2]);
const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-store-benchmark-"));

try {
  const templates = createDemoRuns();
  const runs = Array.from({ length: count }, (_, index) => {
    const template = structuredClone(templates[index % templates.length]);
    return {
      ...template,
      id: `benchmark-${String(index + 1).padStart(6, "0")}`,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    };
  });

  const store = new RunStore(directory);
  const writeStarted = performance.now();
  await store.appendMany(runs);
  const writeMs = performance.now() - writeStarted;

  const readStarted = performance.now();
  const listed = await store.list(count);
  const readMs = performance.now() - readStarted;
  assert.equal(listed.length, count);
  assert.equal(listed[0]?.id, runs.at(-1)?.id);
  assert.equal(listed.at(-1)?.id, runs[0]?.id);

  const bytes = await store.sizeBytes();
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runtime: process.version,
    platform: `${process.platform}/${process.arch}`,
    runs: count,
    bytes,
    mebibytes: round(bytes / 1024 / 1024),
    appendManyMs: round(writeMs),
    fullReadMs: round(readMs),
    readRunsPerSecond: Math.round(count / (readMs / 1_000)),
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function readCount(raw) {
  if (raw === undefined) return 3_000;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("Run count must be a positive integer.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > 50_000) {
    throw new Error("Run count must be between 1 and 50,000.");
  }
  return value;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
