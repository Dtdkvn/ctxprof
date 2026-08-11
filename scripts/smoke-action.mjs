import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const cli = path.resolve("action-dist/action.js");
const result = spawnSync(
  process.execPath,
  [cli],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_CONFIG: path.resolve("ctxprof.config.json"),
      INPUT_PRICING: "",
      NODE_ENV: "production",
    },
  },
);
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
assert.match(result.stdout, /Context budget passed/);
process.stdout.write("Offline GitHub Action smoke test passed.\n");
