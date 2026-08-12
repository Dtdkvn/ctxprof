import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run the package smoke through `npm run smoke:package`.");
const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-package-smoke-"));
try {
  const packed = runNpm(["pack", "--json", "--pack-destination", directory]);
  const result = JSON.parse(packed);
  const manifest = result[0];
  assert.ok(manifest && typeof manifest.filename === "string");
  const fileNames = new Set(manifest.files.map((entry) => entry.path));
  for (const required of [
    "ARCHITECTURE.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "ctxprof.config.json",
    "docs/CI.md",
    "docs/PRIVACY.md",
    "docs/assets/logo.svg",
    "examples/github-actions/context-budget.yml",
  ]) {
    assert.ok(fileNames.has(required), `Packed README dependency is missing: ${required}`);
  }
  await assertPackedMarkdownLinks(fileNames);

  const consumer = path.join(directory, "consumer");
  await writeFile(
    path.join(directory, "consumer-package.json"),
    JSON.stringify({ name: "ctxprof-package-smoke", private: true, type: "module" }),
  );
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), await readFile(path.join(directory, "consumer-package.json")));
  const tarball = path.join(directory, manifest.filename);
  runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", consumer, tarball]);

  const installed = path.join(consumer, "node_modules", "ctxprof");
  const version = run(process.execPath, [path.join(installed, "dist", "cli.js"), "--version"], consumer);
  assert.equal(version.trim(), "ctxprof 0.1.0");
  if (process.platform !== "win32") {
    const binVersion = run(path.join(consumer, "node_modules", ".bin", "ctxprof"), ["--version"], consumer);
    assert.equal(binVersion.trim(), "ctxprof 0.1.0");
  }
  const imported = run(
    process.execPath,
    ["--input-type=module", "-e", "import { estimateTokens } from 'ctxprof'; console.log(estimateTokens('hello'))"],
    consumer,
  );
  assert.equal(imported.trim(), "2");
  const dynamicImport = run(
    process.execPath,
    ["--input-type=commonjs", "-e", "import('ctxprof').then(({ estimateTokens }) => console.log(estimateTokens('hello')))"],
    consumer,
  );
  assert.equal(dynamicImport.trim(), "2");
  run(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      "try { require('ctxprof'); throw new Error('static require unexpectedly succeeded'); } catch (error) { if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM'].includes(error.code)) throw error; }",
    ],
    consumer,
  );
  process.stdout.write(`Packed install smoke passed (${manifest.entryCount} files).\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function assertPackedMarkdownLinks(fileNames) {
  for (const markdown of [...fileNames].filter((name) => name.endsWith(".md"))) {
    const contents = await readFile(path.resolve(markdown), "utf8");
    const targets = [
      ...contents.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g),
      ...contents.matchAll(/<(?:a|img)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi),
    ].map((match) => match[1]);
    for (const rawTarget of targets) {
      if (!rawTarget || /^(?:https?:|mailto:|data:|#)/i.test(rawTarget)) continue;
      const withoutFragment = rawTarget.split("#", 1)[0]?.split("?", 1)[0];
      if (!withoutFragment) continue;
      const decoded = decodeURIComponent(withoutFragment);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(markdown), decoded));
      assert.ok(
        resolved !== ".." && !resolved.startsWith("../") && fileNames.has(resolved),
        `${markdown} links to a file missing from the tarball: ${rawTarget}`,
      );
    }
  }
}

function run(command, args, cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function runNpm(args, cwd = process.cwd()) {
  return run(process.execPath, [npmCli, ...args], cwd);
}
