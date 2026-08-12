#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateBudget,
  makeBaseline,
  metricsForRuns,
  parseBaseline,
  parseBudgetConfig,
  readBaseline,
  readBudgetConfig,
  writeBaseline,
} from "./budget.js";
import { compareVersions, versionsIn } from "./compare.js";
import { createDemoRuns } from "./demo.js";
import { importFile, type ImportOptions, type NamedRun } from "./importer.js";
import { BUILTIN_PRICING, loadPricingFile, parsePricingFile } from "./pricing.js";
import { writeHtmlReport } from "./report.js";
import { safeError } from "./redaction.js";
import { startServer } from "./server.js";
import { RunStore } from "./store.js";
import type { BudgetConfig, ProfileRun } from "./types.js";
import { createWorkspaceScope, readWorkspaceFile, type WorkspaceFile } from "./workspace.js";

const VERSION = "0.1.0";
const MINIMUM_NODE_MAJOR = 22;
const BOOLEAN_OPTIONS = new Set(["help", "json", "allow-remote", "update-baseline", "github"]);
export const COMMAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  analyze: optionSet("help", "json", "pricing", "capture", "label", "prompt-version", "model", "report"),
  import: optionSet("help", "data", "pricing", "capture", "label", "prompt-version", "model"),
  proxy: optionSet("help", "data", "pricing", "capture", "host", "port", "upstream", "upstream-timeout-ms", "allow-remote", "allowed-host", "forward-header", "label", "prompt-version"),
  serve: optionSet("help", "data", "pricing", "host", "port", "allow-remote", "allowed-host", "label", "prompt-version"),
  report: optionSet("help", "data", "output", "title", "limit"),
  compare: optionSet("help", "data", "from", "to", "json"),
  check: optionSet(
    "help", "json", "pricing", "config", "baseline", "update-baseline", "max-input-tokens",
    "max-total-tokens", "max-cost", "max-warnings", "token-regression", "total-regression",
    "cost-regression", "component-regression", "github",
  ),
  demo: optionSet("help", "data", "pricing", "output"),
  pricing: optionSet("help", "json", "pricing"),
  doctor: optionSet("help", "data", "host", "allow-remote"),
};

const COMMAND_HELP: Record<string, { usage: string; summary: string }> = {
  analyze: {
    usage: "ctxprof analyze <files...> [options]",
    summary: "Profile HAR, JSON, or JSONL exchanges without saving them.",
  },
  import: {
    usage: "ctxprof import <files...> [options]",
    summary: "Normalize captures and append them to the local run store.",
  },
  proxy: {
    usage: "ctxprof proxy [options]",
    summary: "Run the recording proxy and polling live dashboard.",
  },
  serve: {
    usage: "ctxprof serve [options]",
    summary: "Serve the polling local capture dashboard without an upstream proxy.",
  },
  report: {
    usage: "ctxprof report [options]",
    summary: "Export recent stored captures as a self-contained HTML report.",
  },
  compare: {
    usage: "ctxprof compare <from-version> <to-version> [options]",
    summary: "Compare aggregate metrics for two prompt versions.",
  },
  check: {
    usage: "ctxprof check [files...] [options]",
    summary: "Fail CI when context tokens, cost, warnings, or components exceed configured limits.",
  },
  demo: {
    usage: "ctxprof demo [options]",
    summary: "Write deterministic local captures and an HTML report without an API key.",
  },
  pricing: {
    usage: "ctxprof pricing [options]",
    summary: "Show the dated built-in pricing catalog plus optional exact overrides.",
  },
  doctor: {
    usage: "ctxprof doctor [options]",
    summary: "Validate the runtime, storage target, capture policy, and bind safety.",
  },
};

const OPTION_HELP: Record<string, { syntax: string; description: string }> = {
  help: { syntax: "--help", description: "Show this command help" },
  json: { syntax: "--json", description: "Write machine-readable JSON" },
  pricing: { syntax: "--pricing <file>", description: "Exact custom model pricing JSON" },
  capture: { syntax: "--capture redacted|none", description: "Stored body policy (default redacted)" },
  label: { syntax: "--label <text>", description: "Override bounded run label metadata" },
  "prompt-version": { syntax: "--prompt-version <text>", description: "Override bounded prompt-version metadata" },
  model: { syntax: "--model <id>", description: "Override the exact model identifier" },
  report: { syntax: "--report <file>", description: "Also write a self-contained HTML report" },
  data: { syntax: "--data <dir>", description: "Store directory (default .ctxprof)" },
  host: { syntax: "--host <address>", description: "Bind address (default 127.0.0.1)" },
  port: { syntax: "--port <0..65535>", description: "Listen port; 0 requests an ephemeral port" },
  upstream: { syntax: "--upstream <url>", description: "OpenAI-compatible http(s) upstream URL" },
  "upstream-timeout-ms": { syntax: "--upstream-timeout-ms <n>", description: "Positive integer upstream deadline" },
  "allow-remote": { syntax: "--allow-remote", description: "Permit a non-loopback bind" },
  "allowed-host": { syntax: "--allowed-host <hostname>", description: "Allow an exact reverse-proxy Host (repeatable)" },
  "forward-header": { syntax: "--forward-header <name>", description: "Opt in one extra upstream header (repeatable)" },
  output: { syntax: "--output <path>", description: "Output file or directory" },
  title: { syntax: "--title <text>", description: "HTML report title" },
  limit: { syntax: "--limit <1..5000>", description: "Maximum recent stored runs" },
  from: { syntax: "--from <version>", description: "Source prompt version" },
  to: { syntax: "--to <version>", description: "Target prompt version" },
  config: { syntax: "--config <file>", description: "Budget config (default ctxprof.config.json)" },
  baseline: { syntax: "--baseline <file>", description: "Override baseline path" },
  "update-baseline": { syntax: "--update-baseline", description: "Write the current metrics as baseline" },
  "max-input-tokens": { syntax: "--max-input-tokens <n>", description: "Absolute input-token ceiling" },
  "max-total-tokens": { syntax: "--max-total-tokens <n>", description: "Absolute input + output-token ceiling" },
  "max-cost": { syntax: "--max-cost <usd>", description: "Absolute estimated-cost ceiling" },
  "max-warnings": { syntax: "--max-warnings <n>", description: "Absolute actionable-warning ceiling" },
  "token-regression": { syntax: "--token-regression <pct>", description: "Allowed input-token growth" },
  "total-regression": { syntax: "--total-regression <pct>", description: "Allowed total-token growth" },
  "cost-regression": { syntax: "--cost-regression <pct>", description: "Allowed estimated-cost growth" },
  "component-regression": { syntax: "--component-regression <pct>", description: "Allowed growth for every component kind" },
  github: { syntax: "--github", description: "Emit GitHub workflow annotations" },
};

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string | boolean | string[]>;
}

export interface MainOptions {
  actionWorkspace?: string;
}

export async function main(argv = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(`ctxprof ${VERSION}\n`);
    return 0;
  }
  const parsed = parseArgs(argv);
  const command = parsed.positionals.shift();
  if (!command || command === "help" || hasFlag(parsed, "help")) {
    printHelp(command === "help" ? parsed.positionals[0] : command);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`ctxprof ${VERSION}\n`);
    return 0;
  }
  const allowedOptions = COMMAND_OPTIONS[command];
  if (allowedOptions) {
    validateOptions(parsed, allowedOptions);
    validateCommandPositionals(command, parsed);
  }
  switch (command) {
    case "analyze":
      return analyzeCommand(parsed);
    case "import":
      return importCommand(parsed);
    case "proxy":
      return serverCommand(parsed, true);
    case "serve":
      return serverCommand(parsed, false);
    case "report":
      return reportCommand(parsed);
    case "compare":
      return compareCommand(parsed);
    case "check":
      return checkCommand(parsed, options);
    case "demo":
      return demoCommand(parsed);
    case "pricing":
      return pricingCommand(parsed);
    case "doctor":
      return doctorCommand(parsed);
    default:
      throw new Error(`Unknown command “${command}”. Run ctxprof help.`);
  }
}

async function analyzeCommand(parsed: ParsedArgs): Promise<number> {
  const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
  const imports = await importInputs(parsed.positionals, importOptions(parsed, pricing));
  const runs = imports.map((entry) => entry.run);
  if (hasFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2)}\n`);
  } else {
    for (const run of runs) printRun(run);
  }
  const reportPath = stringOption(parsed, "report");
  if (reportPath) {
    const output = await writeHtmlReport(runs, reportPath);
    process.stderr.write(`Report written to ${output}\n`);
  }
  return 0;
}

async function importCommand(parsed: ParsedArgs): Promise<number> {
  const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
  const imports = await importInputs(parsed.positionals, importOptions(parsed, pricing));
  const store = new RunStore(dataDirectory(parsed));
  await store.appendMany(imports.map((entry) => entry.run));
  process.stdout.write(
    `Imported ${imports.length} capture${imports.length === 1 ? "" : "s"} into ${store.runsFile}\n`,
  );
  return 0;
}

async function serverCommand(parsed: ParsedArgs, proxy: boolean): Promise<number> {
  const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
  const store = new RunStore(dataDirectory(parsed));
  const host = stringOption(parsed, "host") ?? process.env.CTXPROF_HOST ?? "127.0.0.1";
  const port = integerOption(parsed, "port", 0, 65_535) ?? integerFromEnv("CTXPROF_PORT", 0, 65_535) ?? 8787;
  const capture = proxy ? captureOption(parsed) : "redacted";
  const upstream = proxy
    ? stringOption(parsed, "upstream") ?? process.env.CTXPROF_UPSTREAM ?? "https://api.openai.com"
    : undefined;
  const upstreamTimeoutMs = proxy
    ? integerOption(parsed, "upstream-timeout-ms", 1, 2_147_483_647) ??
      integerFromEnv("CTXPROF_UPSTREAM_TIMEOUT_MS", 1, 2_147_483_647)
    : undefined;
  if (upstream) validateUpstream(upstream);
  const defaultLabel = stringOption(parsed, "label");
  const defaultPromptVersion = stringOption(parsed, "prompt-version");
  const allowedHosts = stringOptions(parsed, "allowed-host");
  const forwardHeaders = proxy ? stringOptions(parsed, "forward-header") : [];
  const running = await startServer({
    host,
    port,
    store,
    ...(upstream ? { upstream } : {}),
    ...(upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs } : {}),
    ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    allowRemote: hasFlag(parsed, "allow-remote"),
    ...(allowedHosts.length ? { allowedHosts } : {}),
    ...(forwardHeaders.length ? { forwardHeaders } : {}),
    captureMode: capture,
    pricing,
    ...(defaultLabel ? { defaultLabel } : {}),
    ...(defaultPromptVersion ? { defaultPromptVersion } : {}),
  });
  try {
    process.stdout.write(`Ctxprof ${proxy ? "proxy + dashboard" : "dashboard"}: ${running.url}\n`);
    if (proxy) {
      process.stdout.write(`Upstream: ${new URL(upstream ?? "").origin}\n`);
      process.stdout.write(`Set your OpenAI-compatible base URL to ${running.url}/v1\n`);
    }
    process.stdout.write(
      `Store: ${store.runsFile}${proxy ? ` · capture: ${capture}` : ""}\nPress Ctrl+C to stop.\n`,
    );
    await waitForStop();
    return 0;
  } finally {
    await running.close();
  }
}

async function reportCommand(parsed: ParsedArgs): Promise<number> {
  const store = new RunStore(dataDirectory(parsed));
  const runs = await store.list(integerOption(parsed, "limit", 1, 5_000) ?? 5_000);
  if (runs.length === 0) throw new Error(`No captures found in ${store.runsFile}.`);
  const output = await writeHtmlReport(
    runs,
    stringOption(parsed, "output") ?? "ctxprof-report.html",
    stringOption(parsed, "title") ?? "Ctxprof context report",
  );
  process.stdout.write(`Self-contained report written to ${output}\n`);
  return 0;
}

async function compareCommand(parsed: ParsedArgs): Promise<number> {
  const from = parsed.positionals[0] ?? stringOption(parsed, "from");
  const to = parsed.positionals[1] ?? stringOption(parsed, "to");
  const store = new RunStore(dataDirectory(parsed));
  const runs = await store.list(5_000);
  if (!from || !to) {
    throw new Error(`Usage: ctxprof compare <from-version> <to-version>. Available: ${versionsIn(runs).join(", ") || "none"}`);
  }
  const result = compareVersions(runs, from, to);
  if (hasFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\nPrompt version diff: ${from} → ${to}\n`);
    process.stdout.write(`${line("Input tokens", signed(result.delta.inputTokens), percent(result.delta.inputTokensPercent))}\n`);
    process.stdout.write(`${line("Total tokens", signed(result.delta.totalTokens), "") }\n`);
    process.stdout.write(`${line("Estimated cost", result.delta.costUsd === null ? "unknown" : signedUsd(result.delta.costUsd), percent(result.delta.costPercent))}\n`);
    process.stdout.write(`Runs compared       ${result.from.runCount} → ${result.to.runCount}\n\n`);
    process.stdout.write("Component deltas\n");
    for (const [kind, delta] of Object.entries(result.delta.components)) {
      process.stdout.write(`  ${kind.padEnd(14)} ${signed(delta)} tok\n`);
    }
  }
  return 0;
}

async function checkCommand(parsed: ParsedArgs, options: MainOptions): Promise<number> {
  const actionScope = options.actionWorkspace
    ? await createWorkspaceScope(options.actionWorkspace)
    : null;
  const explicitConfig = stringOption(parsed, "config");
  const configInput = explicitConfig ?? "ctxprof.config.json";
  const configFile = actionScope
    ? await readWorkspaceFile(actionScope, configInput, actionScope.root, "Budget config")
    : null;
  const configPath = configFile?.path ?? path.resolve(configInput);
  const configExists = configFile ? true : await exists(configPath);
  if (explicitConfig && !configExists) {
    throw new Error(`Budget config not found: ${configPath}`);
  }
  const config = configFile
    ? parseBudgetConfig(configFile.contents)
    : configExists ? await readBudgetConfig(configPath) : {};
  applyCliBudgetOptions(config, parsed);
  const configDirectory = path.dirname(configPath);
  const configuredInputs = parsed.positionals.length ? parsed.positionals : (config.input ?? []);
  const inputBase = parsed.positionals.length ? (actionScope?.root ?? process.cwd()) : configDirectory;
  const inputFiles = actionScope
    ? await Promise.all(configuredInputs.map((entry) =>
      readWorkspaceFile(actionScope, entry, inputBase, "Budget input")))
    : null;
  const inputs = inputFiles
    ? inputFiles.map((file) => file.path)
    : configuredInputs.map((entry) => path.resolve(inputBase, entry));
  if (inputs.length === 0) {
    throw new Error("No budget inputs. Add input files to ctxprof.config.json or pass them after `ctxprof check`.");
  }
  const pricingOption = stringOption(parsed, "pricing");
  const pricingFile = actionScope && pricingOption
    ? await readWorkspaceFile(actionScope, pricingOption, actionScope.root, "Pricing catalog")
    : null;
  const pricing = pricingFile ? parsePricingFile(pricingFile.contents) : await loadPricingFile(pricingOption);
  const imports = await importInputs(inputs, { captureMode: "none", pricing }, configDirectory, inputFiles ?? []);
  const cases = metricsForRuns(imports);
  if (Object.keys(cases).length === 0) {
    throw new Error("No context-budget cases were produced. Every check input must contain at least one supported record.");
  }
  const baselineOption = stringOption(parsed, "baseline") ?? config.baseline;
  const update = hasFlag(parsed, "update-baseline");
  if (actionScope && update) {
    throw new Error("--update-baseline is not available in the GitHub Action. Update and review baselines locally.");
  }
  const baselineFile = actionScope && baselineOption
    ? await readWorkspaceFile(actionScope, baselineOption, configDirectory, "Budget baseline")
    : null;
  const baselinePath = baselineFile?.path ?? (baselineOption ? path.resolve(configDirectory, baselineOption) : null);
  const hasLimits = hasBudgetLimits(config);
  const hasRegressions = hasBudgetRegressions(config);
  if (!hasLimits && !hasRegressions && !update) {
    throw new Error(
      "No context-budget limits are configured. Provide a config file or at least one --max-* or --*-regression option.",
    );
  }
  if (hasRegressions && !baselinePath) {
    throw new Error("Regression limits require a baseline path in config or --baseline <path>.");
  }
  const baseline = baselineFile
    ? parseBaseline(baselineFile.contents)
    : baselinePath ? await readBaseline(baselinePath) : null;
  if (baselinePath && !baseline && !update && (hasRegressions || stringOption(parsed, "baseline") !== undefined)) {
    throw new Error(`Baseline not found at ${baselinePath}. Run ctxprof check --update-baseline once.`);
  }
  // Updating a baseline is an explicit acknowledgement of the new regression
  // reference. Absolute limits still apply, but comparisons to the old file do not.
  const result = evaluateBudget(cases, config, update ? null : baseline);
  if (update) {
    if (!baselinePath) throw new Error("--update-baseline requires baseline in config or --baseline <path>.");
    await writeBaseline(baselinePath, makeBaseline(cases));
    process.stdout.write(`Updated context baseline: ${baselinePath}\n`);
  }
  if (hasFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printBudgetResult(result, hasFlag(parsed, "github") || process.env.GITHUB_ACTIONS === "true");
  }
  return result.passed ? 0 : 1;
}

function hasBudgetLimits(config: BudgetConfig): boolean {
  if (!config.limits) return false;
  return Object.entries(config.limits).some(([key, value]) =>
    key === "components"
      ? Boolean(value && Object.values(value).some((entry) => entry !== undefined))
      : value !== undefined,
  );
}

function hasBudgetRegressions(config: BudgetConfig): boolean {
  return Boolean(config.regressions && Object.values(config.regressions).some((value) => value !== undefined));
}

async function demoCommand(parsed: ParsedArgs): Promise<number> {
  const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
  const runs = createDemoRuns(pricing);
  const store = new RunStore(dataDirectory(parsed));
  await store.appendMany(runs);
  const reportPath = stringOption(parsed, "output") ?? path.join(store.directory, "demo-report.html");
  const output = await writeHtmlReport(runs, reportPath, "Ctxprof demo · Support agent A/B");
  process.stdout.write(`Loaded 2 deterministic captures into ${store.runsFile}\n`);
  process.stdout.write(`Demo report: ${output}\n`);
  process.stdout.write("Compare with: ctxprof compare support-v1 support-v2\n");
  return 0;
}

async function pricingCommand(parsed: ParsedArgs): Promise<number> {
  const custom = await loadPricingFile(stringOption(parsed, "pricing"));
  const records = [...custom, ...BUILTIN_PRICING];
  if (hasFlag(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  process.stdout.write("\nModel                     Input/MTok   Output/MTok   Context      Checked\n");
  process.stdout.write("─".repeat(78) + "\n");
  for (const record of records) {
    process.stdout.write(
      `${record.model.padEnd(25)} ${usd(record.inputPerMillionUsd).padStart(10)} ${usd(record.outputPerMillionUsd).padStart(13)} ${formatNumber(record.contextWindow).padStart(11)}   ${record.checkedAt}\n`,
    );
  }
  process.stdout.write("\nStandard text rates only. Use --pricing catalog.json for any exact provider/model override.\n");
  return 0;
}

async function doctorCommand(parsed: ParsedArgs): Promise<number> {
  const store = new RunStore(dataDirectory(parsed));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const dataCheck = await checkDataDirectory(store.directory);
  const capture = process.env.CTXPROF_CAPTURE ?? "redacted";
  const captureValid = capture === "none" || capture === "redacted";
  const host = stringOption(parsed, "host") ?? process.env.CTXPROF_HOST ?? "127.0.0.1";
  const remoteAllowed = hasFlag(parsed, "allow-remote");
  const bindValid = isLoopbackHost(host) || remoteAllowed;
  const checks = [
    [`Node.js >= ${MINIMUM_NODE_MAJOR}`, nodeMajor >= MINIMUM_NODE_MAJOR, process.version],
    ["Data directory", dataCheck.passed, dataCheck.detail],
    ["Bind policy", bindValid, bindValid
      ? `${host}${isLoopbackHost(host) ? " (loopback)" : " (remote bind explicitly allowed)"}`
      : `${host} is non-loopback; pass --allow-remote only behind a trusted boundary`],
    ["Capture policy", captureValid, captureValid ? capture : `${capture} is invalid; use redacted or none`],
    ["API key in environment", true, process.env.OPENAI_API_KEY ? "set (value hidden)" : "not set (fine for import/demo)"],
  ] as const;
  for (const [name, passed, detail] of checks) {
    process.stdout.write(`${passed ? "✓" : "✗"} ${name.padEnd(25)} ${detail}\n`);
  }
  return checks.every((check) => check[1]) ? 0 : 1;
}

async function checkDataDirectory(target: string): Promise<{ passed: boolean; detail: string }> {
  const resolved = path.resolve(target);
  let existing = resolved;
  while (true) {
    try {
      const information = await stat(existing);
      if (!information.isDirectory()) {
        return { passed: false, detail: `${existing} is not a directory` };
      }
      break;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) return { passed: false, detail: safeError(error) };
      const parent = path.dirname(existing);
      if (parent === existing) return { passed: false, detail: `No accessible parent for ${resolved}` };
      existing = parent;
    }
  }

  let probe: string | undefined;
  try {
    probe = await mkdtemp(path.join(existing, ".ctxprof-doctor-"));
    await rm(probe, { recursive: true });
    probe = undefined;
    return {
      passed: true,
      detail: existing === resolved ? resolved : `${resolved} (parent ${existing} is writable)`,
    };
  } catch (error) {
    return { passed: false, detail: `Cannot create and remove a probe directory: ${safeError(error)}` };
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true }).catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  return normalized.startsWith("::ffff:127.");
}

function importOptions(parsed: ParsedArgs, pricing: Awaited<ReturnType<typeof loadPricingFile>>): ImportOptions {
  const label = stringOption(parsed, "label");
  const promptVersion = stringOption(parsed, "prompt-version");
  const model = stringOption(parsed, "model");
  return {
    captureMode: captureOption(parsed),
    pricing,
    ...(label ? { label } : {}),
    ...(promptVersion ? { promptVersion } : {}),
    ...(model ? { model } : {}),
  };
}

async function importInputs(
  files: readonly string[],
  options: ImportOptions,
  identityRoot = process.cwd(),
  snapshots: readonly WorkspaceFile[] = [],
): Promise<NamedRun[]> {
  const absoluteFiles = files.map((file) => path.resolve(file));
  const canonicalKeys = absoluteFiles.map((file) => process.platform === "win32" ? file.toLowerCase() : file);
  if (new Set(canonicalKeys).size !== canonicalKeys.length) {
    throw new Error("The same budget input file was provided more than once.");
  }
  const basenameCounts = new Map<string, number>();
  for (const file of absoluteFiles) {
    const key = path.basename(file).toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  }
  const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
  const groups = await Promise.all(absoluteFiles.map((file) =>
    importFile(file, options, snapshotByPath.get(file))));
  return groups.flatMap((runs, fileIndex) => {
    const file = absoluteFiles[fileIndex]!;
    if ((basenameCounts.get(path.basename(file).toLowerCase()) ?? 0) === 1) return runs;
    const relative = path.relative(path.resolve(identityRoot), file).split(path.sep).join("/") || path.basename(file);
    return runs.map((named, exchangeIndex) => ({
      ...named,
      name: runs.length === 1 ? relative : `${relative}#${exchangeIndex + 1}`,
    }));
  });
}

function applyCliBudgetOptions(config: BudgetConfig, parsed: ParsedArgs): void {
  config.limits ??= {};
  config.regressions ??= {};
  assignNumber(config.limits, "inputTokens", numberOption(parsed, "max-input-tokens"));
  assignNumber(config.limits, "totalTokens", numberOption(parsed, "max-total-tokens"));
  assignNumber(config.limits, "estimatedCostUsd", numberOption(parsed, "max-cost"));
  assignNumber(config.limits, "warnings", numberOption(parsed, "max-warnings"));
  assignNumber(config.regressions, "inputTokensPercent", numberOption(parsed, "token-regression"));
  assignNumber(config.regressions, "totalTokensPercent", numberOption(parsed, "total-regression"));
  assignNumber(config.regressions, "estimatedCostPercent", numberOption(parsed, "cost-regression"));
  assignNumber(config.regressions, "componentPercent", numberOption(parsed, "component-regression"));
}

function printRun(run: ProfileRun): void {
  const input = run.totals.providerInputTokens ?? run.totals.estimatedInputTokens;
  process.stdout.write(`\n${run.label}  ${run.promptVersion}\n`);
  process.stdout.write(`${run.model} · ${run.endpoint} · ${run.source}\n`);
  process.stdout.write("─".repeat(68) + "\n");
  for (const component of [...run.components].sort((a, b) => b.allocatedInputTokens - a.allocatedInputTokens)) {
    const bar = "█".repeat(Math.max(1, Math.round(component.share * 22)));
    process.stdout.write(
      `${component.label.slice(0, 28).padEnd(29)} ${String(component.allocatedInputTokens).padStart(7)}  ${bar}\n`,
    );
  }
  process.stdout.write("─".repeat(68) + "\n");
  process.stdout.write(`Input ${input.toLocaleString()} tok · Output ${run.totals.outputTokens.toLocaleString()} tok · Cost ${run.totals.estimatedTotalCostUsd === null ? "unknown" : usd(run.totals.estimatedTotalCostUsd)}\n`);
  for (const warning of run.warnings) {
    process.stdout.write(`  ${warning.severity === "critical" ? "!" : warning.severity === "warning" ? "△" : "·"} ${warning.title}\n`);
  }
}

function printBudgetResult(result: ReturnType<typeof evaluateBudget>, github: boolean): void {
  for (const [name, metrics] of Object.entries(result.cases)) {
    process.stdout.write(
      `${result.violations.some((violation) => violation.caseName === name) ? "✗" : "✓"} ${name}: ${metrics.inputTokens.toLocaleString()} input tok, ${metrics.totalTokens.toLocaleString()} total tok, ${metrics.estimatedCostUsd === null ? "cost unknown" : usd(metrics.estimatedCostUsd)}\n`,
    );
  }
  if (result.violations.length) {
    process.stdout.write(`\n${result.violations.length} context budget violation${result.violations.length === 1 ? "" : "s"}:\n`);
    for (const violation of result.violations) {
      process.stdout.write(`  ✗ ${violation.caseName} · ${violation.message}\n`);
      if (github) {
        process.stdout.write(`::error title=Ctxprof context budget::${escapeWorkflow(violation.caseName)} - ${escapeWorkflow(violation.message)}\n`);
      }
    }
  } else {
    process.stdout.write("\n✓ Context budget passed.\n");
  }
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h") {
      options.set("help", true);
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 2) {
      addOption(options, argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (!BOOLEAN_OPTIONS.has(name) && next !== undefined && !next.startsWith("--")) {
      addOption(options, name, next);
      index += 1;
    } else {
      addOption(options, name, true);
    }
  }
  return { positionals, options };
}

function addOption(
  options: Map<string, string | boolean | string[]>,
  name: string,
  value: string | boolean,
): void {
  const prior = options.get(name);
  if (typeof value === "string" && typeof prior === "string") options.set(name, [prior, value]);
  else if (typeof value === "string" && Array.isArray(prior)) options.set(name, [...prior, value]);
  else options.set(name, value);
}

function optionSet(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

function validateOptions(parsed: ParsedArgs, allowed: ReadonlySet<string>): void {
  for (const [name, value] of parsed.options) {
    if (!allowed.has(name)) throw new Error(`Unknown option --${name}. Run ctxprof help.`);
    if (BOOLEAN_OPTIONS.has(name) && value !== true) {
      throw new Error(`--${name} is a flag and does not take a value.`);
    }
    if (!BOOLEAN_OPTIONS.has(name) && value === true) {
      throw new Error(`--${name} requires a value.`);
    }
    if (
      !BOOLEAN_OPTIONS.has(name) &&
      (typeof value === "string" ? value.trim().length === 0 : Array.isArray(value) && value.some((entry) => entry.trim().length === 0))
    ) {
      throw new Error(`--${name} requires a non-empty value.`);
    }
  }
}

function validateCommandPositionals(command: string, parsed: ParsedArgs): void {
  const count = parsed.positionals.length;
  if (command === "analyze" || command === "import") {
    if (count === 0) positionalUsageError(command, "requires at least one input file");
    return;
  }
  if (command === "check") return;
  if (command === "compare") {
    const fromOption = stringOption(parsed, "from");
    const toOption = stringOption(parsed, "to");
    const duplicatesFrom = count >= 1 && fromOption !== undefined;
    const duplicatesTo = count >= 2 && toOption !== undefined;
    const from = parsed.positionals[0] ?? fromOption;
    const to = parsed.positionals[1] ?? toOption;
    if (count > 2 || duplicatesFrom || duplicatesTo || !from || !to) {
      positionalUsageError(
        command,
        "requires exactly two version arguments (two positionals, or the matching --from/--to options)",
      );
    }
    return;
  }
  if (count !== 0) positionalUsageError(command, "does not accept positional arguments");
}

function positionalUsageError(command: string, detail: string): never {
  const usage = COMMAND_HELP[command]?.usage ?? `ctxprof ${command} [options]`;
  throw new Error(`ctxprof ${command} ${detail}. Usage: ${usage}. Run ctxprof help ${command} for details.`);
}

function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options.get(name);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return undefined;
}

function stringOptions(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.options.get(name);
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value : [];
}

function numberOption(parsed: ParsedArgs, name: string): number | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be a non-negative number.`);
  return number;
}

function integerOption(parsed: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const value = stringOption(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.options.get(name) === true;
}

function captureOption(parsed: ParsedArgs): "none" | "redacted" {
  const capture = stringOption(parsed, "capture") ?? process.env.CTXPROF_CAPTURE ?? "redacted";
  if (capture !== "none" && capture !== "redacted") {
    throw new Error("--capture must be `redacted` or `none`. Ctxprof intentionally has no unsafe full-capture mode.");
  }
  return capture;
}

function dataDirectory(parsed: ParsedArgs): string {
  return stringOption(parsed, "data") ?? process.env.CTXPROF_DATA ?? ".ctxprof";
}

function integerFromEnv(name: string, min: number, max: number): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function validateUpstream(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--upstream must be a valid http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--upstream must use http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in --upstream; use Authorization or OPENAI_API_KEY.");
  }
}

function assignNumber(target: object, key: string, value: number | undefined): void {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForStop(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function printHelp(command?: string): void {
  if (command && COMMAND_HELP[command] && COMMAND_OPTIONS[command]) {
    const optionNames = [
      ...[...COMMAND_OPTIONS[command]].filter((name) => name !== "help"),
      ...(COMMAND_OPTIONS[command].has("help") ? ["help"] : []),
    ];
    const optionLines = optionNames.map((name) => {
      const help = OPTION_HELP[name];
      if (!help) throw new Error(`Missing help metadata for --${name}.`);
      return `  ${help.syntax.padEnd(34)} ${help.description}`;
    });
    process.stdout.write(
      `${COMMAND_HELP[command].usage}\n\n${COMMAND_HELP[command].summary}\n\nOptions:\n${optionLines.join("\n")}\n`,
    );
    return;
  }
  process.stdout.write(`ctxprof ${VERSION} — the flamegraph for your context window\n\nUsage:\n  ctxprof <command> [options]\n\nCapture and inspect\n  proxy     Run an OpenAI-compatible recording proxy + dashboard\n  serve     View captures without enabling upstream proxying\n  import    Add HAR, JSON, or JSONL exchanges to the local store\n  analyze   Profile files without saving them\n  report    Export a self-contained interactive HTML report\n  demo      Load a deterministic A/B demo (no API key required)\n\nGuard and compare\n  compare   Compare aggregate prompt versions A → B\n  check     Run a context budget test for CI\n  pricing   Show the dated built-in pricing catalog\n  doctor    Check the local runtime and privacy defaults\n\nCommon options (where supported)\n  --data <dir>                 Store directory (default .ctxprof)\n  --pricing <file>             Exact custom model pricing JSON\n  --capture redacted|none      Stored body policy (default redacted)\n  --help                       Show help\n\nQuick start:\n  ctxprof demo\n  ctxprof serve\n\nProxy an app:\n  ctxprof proxy --upstream https://api.openai.com --port 8787\n  # point the SDK base URL to http://127.0.0.1:8787/v1\n`);
}

function line(name: string, value: string, suffix: string): string {
  return `${name.padEnd(20)} ${value.padStart(12)}  ${suffix}`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toLocaleString()}`;
}

function signedUsd(value: number): string {
  return `${value >= 0 ? "+" : "-"}${usd(Math.abs(value))}`;
}

function percent(value: number | null): string {
  return value === null ? "new" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 6 : 3)}`;
}

function formatNumber(value: number | null): string {
  return value === null ? "unknown" : value.toLocaleString("en-US");
}

function escapeWorkflow(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

if (isDirectExecution()) {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`ctxprof: ${safeError(error)}\n`);
      if (process.env.CTXPROF_DEBUG === "1" && error instanceof Error) process.stderr.write(`${error.stack ?? ""}\n`);
      process.exitCode = 1;
    },
  );
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const entryPath = path.resolve(process.argv[1]);
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryPath);
  } catch {
    return import.meta.url === pathToFileURL(entryPath).href;
  }
}
