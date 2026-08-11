import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = path.join(projectRoot, "dist");
const actionRoot = path.join(projectRoot, "action-dist");
const checkOnly = process.argv.includes("--check");
const expectedFiles = await collectJavaScript(distRoot);
if (expectedFiles.length === 0) throw new Error("Build dist/ before packaging the GitHub Action.");

const expected = new Map();
for (const absolute of expectedFiles) {
  expected.set(relativeTo(distRoot, absolute), await readFile(absolute, "utf8"));
}

const actualFiles = await collectJavaScript(actionRoot, true);
const actualNames = new Set(actualFiles.map((absolute) => relativeTo(actionRoot, absolute)));
const failures = [];

for (const [relative, contents] of expected) {
  const target = path.join(actionRoot, relative);
  if (checkOnly) {
    try {
      if (await readFile(target, "utf8") !== contents) failures.push(`${relative}: stale`);
    } catch (error) {
      if (error && error.code === "ENOENT") failures.push(`${relative}: missing`);
      else throw error;
    }
  } else {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

for (const relative of actualNames) {
  if (expected.has(relative)) continue;
  if (checkOnly) failures.push(`${relative}: unexpected`);
  else await removeActionFile(path.join(actionRoot, relative));
}

if (failures.length > 0) {
  throw new Error(`GitHub Action artifact is not current:\n${failures.join("\n")}`);
}

if (!checkOnly) {
  try {
    await chmod(path.join(actionRoot, "cli.js"), 0o755);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  process.stdout.write(`Updated ${expected.size} offline Action modules in action-dist/.\n`);
} else {
  process.stdout.write(`GitHub Action artifact matches ${expected.size} built modules.\n`);
}

async function collectJavaScript(root, allowMissing = false) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (allowMissing && error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) result.push(target);
    }
  }
  await visit(root);
  return result.sort();
}

function relativeTo(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function removeActionFile(target) {
  const resolved = path.resolve(target);
  const prefix = `${path.resolve(actionRoot)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`Refusing to remove unexpected path: ${resolved}`);
  await rm(resolved, { force: true });
}
