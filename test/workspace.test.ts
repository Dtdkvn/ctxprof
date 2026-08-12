import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceScope, readWorkspaceFile } from "../src/workspace.js";

test("workspace reads return a verified snapshot rather than a pathname to reopen", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-workspace-snapshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "policy.json");
  await writeFile(target, "{\"limit\":1}\n");

  const scope = await createWorkspaceScope(directory);
  const snapshot = await readWorkspaceFile(scope, "policy.json", scope.root, "Policy");
  await rm(target);

  assert.equal(snapshot.path, target);
  assert.deepEqual(JSON.parse(snapshot.contents), { limit: 1 });
  assert.match(snapshot.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});
