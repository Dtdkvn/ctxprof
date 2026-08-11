import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { COMMAND_OPTIONS } from "../src/cli.js";

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

test("every accepted command option is generated into per-command help", () => {
  for (const [command, options] of Object.entries(COMMAND_OPTIONS)) {
    const result = runCli(["help", command]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    for (const option of options) {
      assert.match(result.stdout, new RegExp(`--${escapeRegExp(option)}(?:[\\s<]|$)`), `${command} omits --${option}`);
    }
  }
  const serve = runCli(["help", "serve"]);
  assert.doesNotMatch(serve.stdout, /--capture/);
  for (const option of ["--pricing", "--label", "--prompt-version"]) assert.match(serve.stdout, new RegExp(option));
});

test("doctor enforces the package Node.js 22 runtime contract", () => {
  const result = runDoctor("20.20.2");
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Node\.js >= 22/);
  assert.doesNotMatch(result.stdout, /Node\.js >= 20/);
});

test("doctor fails invalid capture, data-directory, and bind configurations", () => {
  const invalidCapture = runDoctor("24.0.0", [], { CTXPROF_CAPTURE: "full" });
  assert.equal(invalidCapture.status, 1);
  assert.match(invalidCapture.stdout, /Capture policy.*full is invalid/);

  const fileTarget = runDoctor("24.0.0", ["--data", path.resolve("package.json")]);
  assert.equal(fileTarget.status, 1);
  assert.match(fileTarget.stdout, /Data directory.*is not a directory/);

  const unsafeBind = runDoctor("24.0.0", [], { CTXPROF_HOST: "0.0.0.0" });
  assert.equal(unsafeBind.status, 1);
  assert.match(unsafeBind.stdout, /Bind policy.*non-loopback/);

  const explicitRemote = runDoctor("24.0.0", ["--host", "0.0.0.0", "--allow-remote"]);
  assert.equal(explicitRemote.status, 0, `${explicitRemote.stderr}\n${explicitRemote.stdout}`);
  assert.match(explicitRemote.stdout, /remote bind explicitly allowed/);
});

test("empty value options fail before a proxy listener can keep the process alive", () => {
  const result = runCli(["proxy", "--upstream=", "--port", "0"], {}, process.cwd(), 3_000);
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /--upstream requires a non-empty value/);
});

test("commands reject unexpected positional arguments with command-specific help", () => {
  for (const args of [
    ["pricing", "stray"],
    ["doctor", "stray"],
    ["compare", "a", "b", "c"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, new RegExp(`Usage: ctxprof ${args[0]}`));
    assert.match(result.stderr, new RegExp(`ctxprof help ${args[0]}`));
  }
});

test("check fails closed for missing configs and regression rules without a baseline", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-cli-check-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = path.resolve("test/fixtures/chat-baseline.json");
  const missing = runCli(["check", fixture, "--config", path.join(directory, "missing.json")]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Budget config not found/);

  const configlessRegression = runCli(["check", fixture, "--token-regression", "0"], {}, directory);
  assert.equal(configlessRegression.status, 1);
  assert.match(configlessRegression.stderr, /Regression limits require a baseline/);

  const noPolicy = runCli(["check", fixture], {}, directory);
  assert.equal(noPolicy.status, 1);
  assert.match(noPolicy.stderr, /No context-budget limits are configured/);

  const configPath = path.join(directory, "regression.json");
  await writeFile(configPath, JSON.stringify({ input: [fixture], regressions: { inputTokensPercent: 0 } }));
  const missingBaseline = runCli(["check", "--config", configPath], {}, directory);
  assert.equal(missingBaseline.status, 1);
  assert.match(missingBaseline.stderr, /Regression limits require a baseline/);
});

test("report, port, and timeout integer options enforce their command bounds", () => {
  for (const value of ["0", "1.5", "5001"]) {
    const result = runCli(["report", "--limit", value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--limit must be an integer from 1 to 5000/);
  }
  for (const value of ["-1", "1.5", "65536"]) {
    const result = runCli(["proxy", "--port", value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--port must be an integer from 0 to 65535/);
  }
  for (const value of ["0", "1.5", "2147483648"]) {
    const result = runCli(["proxy", "--upstream-timeout-ms", value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--upstream-timeout-ms must be an integer from 1 to 2147483647/);
  }
});

test("budget case identities stay stable when colliding basenames are reordered", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-case-identity-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const contents = await readFile(path.resolve("test/fixtures/chat-baseline.json"), "utf8");
  const first = path.join(directory, "a", "same.json");
  const second = path.join(directory, "b", "same.json");
  await mkdir(path.dirname(first), { recursive: true });
  await mkdir(path.dirname(second), { recursive: true });
  await writeFile(first, contents);
  await writeFile(second, contents);

  const args = ["--max-input-tokens", "100000", "--json"];
  const forward = runCli(["check", first, second, ...args], {}, directory);
  const reverse = runCli(["check", second, first, ...args], {}, directory);
  assert.equal(forward.status, 0, forward.stderr);
  assert.equal(reverse.status, 0, reverse.stderr);
  const forwardCases = Object.keys((JSON.parse(forward.stdout) as { cases: object }).cases).sort();
  const reverseCases = Object.keys((JSON.parse(reverse.stdout) as { cases: object }).cases).sort();
  assert.deepEqual(forwardCases, ["a/same.json", "b/same.json"]);
  assert.deepEqual(reverseCases, forwardCases);
});

test("analyze, import, and check reject a mixed valid and empty input set", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-empty-input-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const valid = path.resolve("test/fixtures/chat-baseline.json");
  const empty = path.join(directory, "empty.jsonl");
  const data = path.join(directory, "data");
  await writeFile(empty, "", "utf8");

  const commands = [
    ["analyze", valid, empty, "--json"],
    ["import", valid, empty, "--data", data],
    ["check", valid, empty, "--max-input-tokens", "100000", "--json"],
  ];
  for (const args of commands) {
    const result = runCli(args, {}, directory);
    assert.equal(result.status, 1, `${args[0]}: ${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /No supported records.*empty\.jsonl/);
  }

  await assert.rejects(() => readFile(path.join(data, "runs.jsonl")), { code: "ENOENT" });
});

function runDoctor(
  nodeVersion: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
) {
  const cliUrl = pathToFileURL(path.resolve(".test-dist/src/cli.js")).href;
  const script = [
    `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(nodeVersion)} });`,
    `const { main } = await import(${JSON.stringify(cliUrl)});`,
    `process.exitCode = await main(${JSON.stringify(["doctor", ...args])});`,
  ].join("\n");
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CTXPROF_CAPTURE: "redacted",
      CTXPROF_HOST: "127.0.0.1",
      ...environment,
    },
  });
}

function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
  timeout = 10_000,
) {
  return spawnSync(process.execPath, [path.resolve(".test-dist/src/cli.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...environment },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
