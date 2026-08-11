import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions } from "../src/compare.js";
import { createDemoRuns } from "../src/demo.js";

test("compares stable prompt versions rather than adjacent turns", () => {
  const result = compareVersions(createDemoRuns(), "support-v1", "support-v2");
  assert.ok(result.delta.inputTokens < 0);
  assert.ok((result.delta.costUsd ?? 0) < 0);
  assert.equal(result.from.runCount, 1);
  assert.equal(result.to.runCount, 1);
});
