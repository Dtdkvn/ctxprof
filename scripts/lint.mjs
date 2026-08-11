import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roots = ["src", "test", "scripts", "docs", "examples", ".github"];
const rootFiles = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.test.json",
  "ctxprof.config.json",
  "ctxprof.pricing.example.json",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "Dockerfile",
  "docker-compose.yml",
  "action.yml",
  "Makefile",
];
const checkedExtensions = new Set([".ts", ".mjs", ".json", ".md", ".yml", ".yaml"]);
const failures = [];

for (const file of [...(await collectFiles(roots)), ...rootFiles]) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") continue;
    throw error;
  }
  if (!contents.endsWith("\n")) failures.push(`${file}: missing final newline`);
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) failures.push(`${file}:${index + 1}: trailing whitespace`);
    if (file !== "Makefile" && line.includes("\t")) failures.push(`${file}:${index + 1}: tab character`);
  });
  if (path.extname(file) === ".json") {
    try {
      JSON.parse(contents);
    } catch (error) {
      failures.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Repository lint passed.\n");
}

async function collectFiles(directories) {
  const result = [];
  for (const directory of directories) {
    await visit(directory, result);
  }
  return result;
}

async function visit(directory, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target, result);
    else if (checkedExtensions.has(path.extname(entry.name))) result.push(target);
  }
}
