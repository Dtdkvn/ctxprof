import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("the Node 24 Action entrypoint runs the budget without an install step", () => {
  const result = spawnSync(process.execPath, [path.resolve(".test-dist/src/action.js")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_CONFIG: path.resolve("ctxprof.config.json"),
      INPUT_PRICING: "",
      NODE_ENV: "production",
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Context budget passed/);
});
