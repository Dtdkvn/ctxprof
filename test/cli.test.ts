import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

test("check help documents every accepted budget flag", () => {
  const result = spawnSync(
    process.execPath,
    [path.resolve(".test-dist/src/cli.js"), "help", "check"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const option of [
    "--max-input-tokens",
    "--max-total-tokens",
    "--max-cost",
    "--max-warnings",
    "--token-regression",
    "--total-regression",
    "--cost-regression",
    "--component-regression",
  ]) {
    assert.match(result.stdout, new RegExp(option));
  }
});
