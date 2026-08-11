import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-smoke-"));
try {
  run(["analyze", "test/fixtures/chat-baseline.json", "--json"]);
  run(["demo", "--data", directory]);
  const compare = run(["compare", "support-v1", "support-v2", "--data", directory, "--json"]);
  const parsed = JSON.parse(compare);
  assert.ok(parsed.delta.inputTokens < 0);
  run(["check"]);
  process.stdout.write("CLI smoke test passed.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(arguments_) {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ctxprof ${arguments_.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}
