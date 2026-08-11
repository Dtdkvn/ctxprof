import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const testDirectory = path.resolve(".test-dist/test");
const tests = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (tests.length === 0) throw new Error(`No compiled tests found in ${testDirectory}.`);
const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit", shell: false });
if (result.error) throw result.error;
if (result.signal) {
  process.stderr.write(`Test runner stopped by ${result.signal}.\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
