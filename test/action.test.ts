import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";

const actionEntry = path.resolve(".test-dist/src/action.js");

test("the Node 24 Action entrypoint runs the budget without an install step", () => {
  const result = runAction(process.cwd());
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Context budget passed/);
});

test("the Action fails closed when its explicit config input is missing", () => {
  const result = runAction(process.cwd(), "test/fixtures/does-not-exist.json");
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Budget config not found/);
  assert.match(result.stdout, /::error title=Ctxprof action failed/);
});

test("the Action requires a canonical GITHUB_WORKSPACE directory", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "ctxprof-action-workspace-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspaceFile = path.join(root, "workspace.txt");
  await writeFile(workspaceFile, "not a directory");

  for (const workspace of ["", path.join(root, "missing"), workspaceFile]) {
    const result = runAction(workspace, "ctxprof.config.json", "", root);
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /GITHUB_WORKSPACE/);
  }
});

test("the Action rejects parent and absolute paths for every file-bearing input", async (context) => {
  const fixture = await createActionFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const validConfig = budgetConfig();
  const scenarios: ActionScenario[] = [
    {
      name: "parent config",
      config: "../outside/config.json",
      document: validConfig,
      pattern: /Budget config escapes GITHUB_WORKSPACE/,
    },
    {
      name: "parent pricing",
      config: "ctxprof.config.json",
      pricing: "../outside/pricing.json",
      document: validConfig,
      pattern: /Pricing catalog escapes GITHUB_WORKSPACE/,
    },
    {
      name: "parent input",
      config: "ctxprof.config.json",
      document: budgetConfig({ input: ["../outside/input.json"] }),
      pattern: /Budget input escapes GITHUB_WORKSPACE/,
    },
    {
      name: "parent baseline",
      config: "ctxprof.config.json",
      document: budgetConfig({ baseline: "../outside/baseline.json" }),
      pattern: /Budget baseline escapes GITHUB_WORKSPACE/,
    },
    {
      name: "absolute config",
      config: path.join(fixture.outside, "config.json"),
      document: validConfig,
      pattern: /Budget config must be a relative path/,
    },
    {
      name: "absolute pricing",
      config: "ctxprof.config.json",
      pricing: path.join(fixture.outside, "pricing.json"),
      document: validConfig,
      pattern: /Pricing catalog must be a relative path/,
    },
    {
      name: "absolute input",
      config: "ctxprof.config.json",
      document: budgetConfig({ input: [path.join(fixture.outside, "input.json")] }),
      pattern: /Budget input must be a relative path/,
    },
    {
      name: "absolute baseline",
      config: "ctxprof.config.json",
      document: budgetConfig({ baseline: path.join(fixture.outside, "baseline.json") }),
      pattern: /Budget baseline must be a relative path/,
    },
  ];

  for (const scenario of scenarios) {
    await writeFile(path.join(fixture.workspace, "ctxprof.config.json"), JSON.stringify(scenario.document));
    const result = runAction(fixture.workspace, scenario.config, scenario.pricing ?? "");
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}\n${result.stdout}`);
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.pattern, scenario.name);
  }
});

test("the Action rejects symlink escapes for config, pricing, inputs, and baselines", async (context) => {
  const fixture = await createActionFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await symlink(fixture.outside, path.join(fixture.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  const scenarios: ActionScenario[] = [
    {
      name: "config",
      config: "escape/config.json",
      document: budgetConfig(),
      pattern: /Budget config escapes GITHUB_WORKSPACE through a symbolic link/,
    },
    {
      name: "pricing",
      config: "ctxprof.config.json",
      pricing: "escape/pricing.json",
      document: budgetConfig(),
      pattern: /Pricing catalog escapes GITHUB_WORKSPACE through a symbolic link/,
    },
    {
      name: "input",
      config: "ctxprof.config.json",
      document: budgetConfig({ input: ["escape/input.json"] }),
      pattern: /Budget input escapes GITHUB_WORKSPACE through a symbolic link/,
    },
    {
      name: "baseline",
      config: "ctxprof.config.json",
      document: budgetConfig({ baseline: "escape/baseline.json" }),
      pattern: /Budget baseline escapes GITHUB_WORKSPACE through a symbolic link/,
    },
  ];

  for (const scenario of scenarios) {
    await writeFile(path.join(fixture.workspace, "ctxprof.config.json"), JSON.stringify(scenario.document));
    const result = runAction(fixture.workspace, scenario.config, scenario.pricing ?? "");
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}\n${result.stdout}`);
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.pattern, scenario.name);
  }
});

test("the Action requires config, pricing, inputs, and baselines to be regular files", async (context) => {
  const fixture = await createActionFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const scenarios: ActionScenario[] = [
    {
      name: "config",
      config: ".",
      document: budgetConfig(),
      pattern: /Budget config must resolve to a regular file/,
    },
    {
      name: "pricing",
      config: "ctxprof.config.json",
      pricing: ".",
      document: budgetConfig(),
      pattern: /Pricing catalog must resolve to a regular file/,
    },
    {
      name: "input",
      config: "ctxprof.config.json",
      document: budgetConfig({ input: ["."] }),
      pattern: /Budget input must resolve to a regular file/,
    },
    {
      name: "baseline",
      config: "ctxprof.config.json",
      document: budgetConfig({ baseline: "." }),
      pattern: /Budget baseline must resolve to a regular file/,
    },
  ];

  for (const scenario of scenarios) {
    await writeFile(path.join(fixture.workspace, "ctxprof.config.json"), JSON.stringify(scenario.document));
    const result = runAction(fixture.workspace, scenario.config, scenario.pricing ?? "");
    assert.equal(result.status, 1, `${scenario.name}: ${result.stderr}\n${result.stdout}`);
    assert.match(`${result.stdout}\n${result.stderr}`, scenario.pattern, scenario.name);
  }
});

test("the Action accepts in-workspace symbolic links to regular files", async (context) => {
  const fixture = await createActionFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const files = path.join(fixture.workspace, "files");
  await mkdir(files);
  await Promise.all([
    writeFile(path.join(files, "input.json"), await readFile(path.join(fixture.workspace, "input.json"))),
    writeFile(path.join(files, "baseline.json"), await readFile(path.join(fixture.workspace, "baseline.json"))),
    writeFile(path.join(files, "pricing.json"), "[]\n"),
  ]);
  await symlink(files, path.join(fixture.workspace, "linked-files"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(fixture.workspace, "ctxprof.config.json"), JSON.stringify(budgetConfig({
    input: ["linked-files/input.json"],
    baseline: "linked-files/baseline.json",
  })));

  const result = runAction(fixture.workspace, "ctxprof.config.json", "linked-files/pricing.json");
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Context budget passed/);
});

interface ActionFixture {
  root: string;
  workspace: string;
  outside: string;
}

interface ActionScenario {
  name: string;
  config: string;
  pricing?: string;
  document: Record<string, unknown>;
  pattern: RegExp;
}

async function createActionFixture(): Promise<ActionFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ctxprof-action-boundary-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const [input, baseline] = await Promise.all([
    readFile(path.resolve("test/fixtures/chat-baseline.json"), "utf8"),
    readFile(path.resolve("test/fixtures/context-baseline.json"), "utf8"),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, "input.json"), input),
    writeFile(path.join(workspace, "baseline.json"), baseline),
    writeFile(path.join(workspace, "pricing.json"), "[]\n"),
    writeFile(path.join(outside, "input.json"), input),
    writeFile(path.join(outside, "baseline.json"), baseline),
    writeFile(path.join(outside, "pricing.json"), "[]\n"),
    writeFile(path.join(outside, "config.json"), JSON.stringify(budgetConfig({ input: ["input.json"] }))),
  ]);
  return { root, workspace, outside };
}

function budgetConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: ["input.json"],
    limits: { inputTokens: 100_000 },
    ...overrides,
  };
}

function runAction(workspace: string, config = "ctxprof.config.json", pricing = "", cwd = workspace || process.cwd()) {
  return spawnSync(process.execPath, [actionEntry], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      INPUT_CONFIG: config,
      INPUT_PRICING: pricing,
      NODE_ENV: "production",
    },
  });
}
