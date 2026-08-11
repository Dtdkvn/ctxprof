#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateBudget, makeBaseline, metricsForRuns, readBaseline, readBudgetConfig, writeBaseline } from "./budget.js";
import { compareVersions, versionsIn } from "./compare.js";
import { createDemoRuns } from "./demo.js";
import { importFile } from "./importer.js";
import { BUILTIN_PRICING, loadPricingFile } from "./pricing.js";
import { writeHtmlReport } from "./report.js";
import { safeError } from "./redaction.js";
import { startServer } from "./server.js";
import { RunStore } from "./store.js";
const VERSION = "0.1.0";
const BOOLEAN_OPTIONS = new Set(["help", "json", "allow-remote", "update-baseline", "github"]);
const COMMAND_OPTIONS = {
    analyze: optionSet("help", "json", "pricing", "capture", "label", "prompt-version", "model", "report"),
    import: optionSet("help", "data", "pricing", "capture", "label", "prompt-version", "model"),
    proxy: optionSet("help", "data", "pricing", "capture", "host", "port", "upstream", "upstream-timeout-ms", "allow-remote", "allowed-host", "label", "prompt-version"),
    serve: optionSet("help", "data", "pricing", "capture", "host", "port", "allow-remote", "allowed-host", "label", "prompt-version"),
    report: optionSet("help", "data", "output", "title", "limit"),
    compare: optionSet("help", "data", "from", "to", "json"),
    check: optionSet("help", "json", "pricing", "config", "baseline", "update-baseline", "max-input-tokens", "max-total-tokens", "max-cost", "max-warnings", "token-regression", "total-regression", "cost-regression", "component-regression", "github"),
    demo: optionSet("help", "data", "pricing", "output"),
    pricing: optionSet("help", "json", "pricing"),
    doctor: optionSet("help", "data"),
};
export async function main(argv = process.argv.slice(2)) {
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
    if (allowedOptions)
        validateOptions(parsed, allowedOptions);
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
            return checkCommand(parsed);
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
async function analyzeCommand(parsed) {
    requireFiles(parsed);
    const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
    const imports = await importInputs(parsed.positionals, importOptions(parsed, pricing));
    const runs = imports.map((entry) => entry.run);
    if (hasFlag(parsed, "json")) {
        process.stdout.write(`${JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2)}\n`);
    }
    else {
        for (const run of runs)
            printRun(run);
    }
    const reportPath = stringOption(parsed, "report");
    if (reportPath) {
        const output = await writeHtmlReport(runs, reportPath);
        process.stderr.write(`Report written to ${output}\n`);
    }
    return 0;
}
async function importCommand(parsed) {
    requireFiles(parsed);
    const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
    const imports = await importInputs(parsed.positionals, importOptions(parsed, pricing));
    const store = new RunStore(dataDirectory(parsed));
    await store.appendMany(imports.map((entry) => entry.run));
    process.stdout.write(`Imported ${imports.length} capture${imports.length === 1 ? "" : "s"} into ${store.runsFile}\n`);
    return 0;
}
async function serverCommand(parsed, proxy) {
    const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
    const store = new RunStore(dataDirectory(parsed));
    const host = stringOption(parsed, "host") ?? process.env.CTXPROF_HOST ?? "127.0.0.1";
    const port = portNumber(numberOption(parsed, "port") ?? numberFromEnv("CTXPROF_PORT") ?? 8787);
    const capture = captureOption(parsed);
    const upstream = proxy
        ? stringOption(parsed, "upstream") ?? process.env.CTXPROF_UPSTREAM ?? "https://api.openai.com"
        : undefined;
    const upstreamTimeoutMs = proxy
        ? numberOption(parsed, "upstream-timeout-ms") ?? numberFromEnv("CTXPROF_UPSTREAM_TIMEOUT_MS")
        : undefined;
    if (upstream)
        validateUpstream(upstream);
    const defaultLabel = stringOption(parsed, "label");
    const defaultPromptVersion = stringOption(parsed, "prompt-version");
    const allowedHosts = stringOptions(parsed, "allowed-host");
    const running = await startServer({
        host,
        port,
        store,
        ...(upstream ? { upstream } : {}),
        ...(upstreamTimeoutMs !== undefined ? { upstreamTimeoutMs } : {}),
        ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
        allowRemote: hasFlag(parsed, "allow-remote"),
        ...(allowedHosts.length ? { allowedHosts } : {}),
        captureMode: capture,
        pricing,
        ...(defaultLabel ? { defaultLabel } : {}),
        ...(defaultPromptVersion ? { defaultPromptVersion } : {}),
    });
    process.stdout.write(`Ctxprof ${proxy ? "proxy + dashboard" : "dashboard"}: ${running.url}\n`);
    if (proxy) {
        process.stdout.write(`Upstream: ${new URL(upstream ?? "").origin}\n`);
        process.stdout.write(`Set your OpenAI-compatible base URL to ${running.url}/v1\n`);
    }
    process.stdout.write(`Store: ${store.runsFile} · capture: ${capture}\nPress Ctrl+C to stop.\n`);
    await waitForStop();
    await running.close();
    return 0;
}
async function reportCommand(parsed) {
    const store = new RunStore(dataDirectory(parsed));
    const runs = await store.list(numberOption(parsed, "limit") ?? 5_000);
    if (runs.length === 0)
        throw new Error(`No captures found in ${store.runsFile}.`);
    const output = await writeHtmlReport(runs, stringOption(parsed, "output") ?? "ctxprof-report.html", stringOption(parsed, "title") ?? "Ctxprof context report");
    process.stdout.write(`Self-contained report written to ${output}\n`);
    return 0;
}
async function compareCommand(parsed) {
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
    }
    else {
        process.stdout.write(`\nPrompt version diff: ${from} → ${to}\n`);
        process.stdout.write(`${line("Input tokens", signed(result.delta.inputTokens), percent(result.delta.inputTokensPercent))}\n`);
        process.stdout.write(`${line("Total tokens", signed(result.delta.totalTokens), "")}\n`);
        process.stdout.write(`${line("Estimated cost", result.delta.costUsd === null ? "unknown" : signedUsd(result.delta.costUsd), percent(result.delta.costPercent))}\n`);
        process.stdout.write(`Runs compared       ${result.from.runCount} → ${result.to.runCount}\n\n`);
        process.stdout.write("Component deltas\n");
        for (const [kind, delta] of Object.entries(result.delta.components)) {
            process.stdout.write(`  ${kind.padEnd(14)} ${signed(delta)} tok\n`);
        }
    }
    return 0;
}
async function checkCommand(parsed) {
    const configPath = path.resolve(stringOption(parsed, "config") ?? "ctxprof.config.json");
    const configExists = await exists(configPath);
    const config = configExists ? await readBudgetConfig(configPath) : {};
    applyCliBudgetOptions(config, parsed);
    const configDirectory = path.dirname(configPath);
    const inputs = parsed.positionals.length
        ? parsed.positionals.map((entry) => path.resolve(entry))
        : (config.input ?? []).map((entry) => path.resolve(configDirectory, entry));
    if (inputs.length === 0) {
        throw new Error("No budget inputs. Add input files to ctxprof.config.json or pass them after `ctxprof check`.");
    }
    const pricing = await loadPricingFile(stringOption(parsed, "pricing"));
    const imports = await importInputs(inputs, { captureMode: "none", pricing });
    const cases = metricsForRuns(imports);
    const baselineOption = stringOption(parsed, "baseline") ?? config.baseline;
    const baselinePath = baselineOption ? path.resolve(configDirectory, baselineOption) : null;
    const update = hasFlag(parsed, "update-baseline");
    const baseline = baselinePath ? await readBaseline(baselinePath) : null;
    if (baselinePath && !baseline && !update && config.regressions) {
        throw new Error(`Baseline not found at ${baselinePath}. Run ctxprof check --update-baseline once.`);
    }
    // Updating a baseline is an explicit acknowledgement of the new regression
    // reference. Absolute limits still apply, but comparisons to the old file do not.
    const result = evaluateBudget(cases, config, update ? null : baseline);
    if (update) {
        if (!baselinePath)
            throw new Error("--update-baseline requires baseline in config or --baseline <path>.");
        await writeBaseline(baselinePath, makeBaseline(cases));
        process.stdout.write(`Updated context baseline: ${baselinePath}\n`);
    }
    if (hasFlag(parsed, "json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    else {
        printBudgetResult(result, hasFlag(parsed, "github") || process.env.GITHUB_ACTIONS === "true");
    }
    return result.passed ? 0 : 1;
}
async function demoCommand(parsed) {
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
async function pricingCommand(parsed) {
    const custom = await loadPricingFile(stringOption(parsed, "pricing"));
    const records = [...custom, ...BUILTIN_PRICING];
    if (hasFlag(parsed, "json")) {
        process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
        return 0;
    }
    process.stdout.write("\nModel                     Input/MTok   Output/MTok   Context      Checked\n");
    process.stdout.write("─".repeat(78) + "\n");
    for (const record of records) {
        process.stdout.write(`${record.model.padEnd(25)} ${usd(record.inputPerMillionUsd).padStart(10)} ${usd(record.outputPerMillionUsd).padStart(13)} ${formatNumber(record.contextWindow).padStart(11)}   ${record.checkedAt}\n`);
    }
    process.stdout.write("\nStandard text rates only. Use --pricing catalog.json for any exact provider/model override.\n");
    return 0;
}
async function doctorCommand(parsed) {
    const store = new RunStore(dataDirectory(parsed));
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const checks = [
        ["Node.js >= 20", nodeMajor >= 20, process.version],
        ["Data directory", true, store.directory],
        ["Default bind", true, process.env.CTXPROF_HOST ?? "127.0.0.1 (loopback)"],
        ["Capture policy", true, process.env.CTXPROF_CAPTURE ?? "redacted"],
        ["API key in environment", true, process.env.OPENAI_API_KEY ? "set (value hidden)" : "not set (fine for import/demo)"],
    ];
    for (const [name, passed, detail] of checks) {
        process.stdout.write(`${passed ? "✓" : "✗"} ${name.padEnd(25)} ${detail}\n`);
    }
    return checks.every((check) => check[1]) ? 0 : 1;
}
function importOptions(parsed, pricing) {
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
async function importInputs(files, options) {
    const groups = await Promise.all(files.map((file) => importFile(file, options)));
    return groups.flat();
}
function applyCliBudgetOptions(config, parsed) {
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
function printRun(run) {
    const input = run.totals.providerInputTokens ?? run.totals.estimatedInputTokens;
    process.stdout.write(`\n${run.label}  ${run.promptVersion}\n`);
    process.stdout.write(`${run.model} · ${run.endpoint} · ${run.source}\n`);
    process.stdout.write("─".repeat(68) + "\n");
    for (const component of [...run.components].sort((a, b) => b.allocatedInputTokens - a.allocatedInputTokens)) {
        const bar = "█".repeat(Math.max(1, Math.round(component.share * 22)));
        process.stdout.write(`${component.label.slice(0, 28).padEnd(29)} ${String(component.allocatedInputTokens).padStart(7)}  ${bar}\n`);
    }
    process.stdout.write("─".repeat(68) + "\n");
    process.stdout.write(`Input ${input.toLocaleString()} tok · Output ${run.totals.outputTokens.toLocaleString()} tok · Cost ${run.totals.estimatedTotalCostUsd === null ? "unknown" : usd(run.totals.estimatedTotalCostUsd)}\n`);
    for (const warning of run.warnings) {
        process.stdout.write(`  ${warning.severity === "critical" ? "!" : warning.severity === "warning" ? "△" : "·"} ${warning.title}\n`);
    }
}
function printBudgetResult(result, github) {
    for (const [name, metrics] of Object.entries(result.cases)) {
        process.stdout.write(`${result.violations.some((violation) => violation.caseName === name) ? "✗" : "✓"} ${name}: ${metrics.inputTokens.toLocaleString()} input tok, ${metrics.totalTokens.toLocaleString()} total tok, ${metrics.estimatedCostUsd === null ? "cost unknown" : usd(metrics.estimatedCostUsd)}\n`);
    }
    if (result.violations.length) {
        process.stdout.write(`\n${result.violations.length} context budget violation${result.violations.length === 1 ? "" : "s"}:\n`);
        for (const violation of result.violations) {
            process.stdout.write(`  ✗ ${violation.caseName} · ${violation.message}\n`);
            if (github) {
                process.stdout.write(`::error title=Ctxprof context budget::${escapeWorkflow(violation.caseName)} - ${escapeWorkflow(violation.message)}\n`);
            }
        }
    }
    else {
        process.stdout.write("\n✓ Context budget passed.\n");
    }
}
function parseArgs(argv) {
    const positionals = [];
    const options = new Map();
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
        }
        else {
            addOption(options, name, true);
        }
    }
    return { positionals, options };
}
function addOption(options, name, value) {
    const prior = options.get(name);
    if (typeof value === "string" && typeof prior === "string")
        options.set(name, [prior, value]);
    else if (typeof value === "string" && Array.isArray(prior))
        options.set(name, [...prior, value]);
    else
        options.set(name, value);
}
function optionSet(...values) {
    return new Set(values);
}
function validateOptions(parsed, allowed) {
    for (const [name, value] of parsed.options) {
        if (!allowed.has(name))
            throw new Error(`Unknown option --${name}. Run ctxprof help.`);
        if (BOOLEAN_OPTIONS.has(name) && value !== true) {
            throw new Error(`--${name} is a flag and does not take a value.`);
        }
        if (!BOOLEAN_OPTIONS.has(name) && value === true) {
            throw new Error(`--${name} requires a value.`);
        }
    }
}
function stringOption(parsed, name) {
    const value = parsed.options.get(name);
    if (typeof value === "string")
        return value;
    if (Array.isArray(value))
        return value[value.length - 1];
    return undefined;
}
function stringOptions(parsed, name) {
    const value = parsed.options.get(name);
    if (typeof value === "string")
        return [value];
    return Array.isArray(value) ? value : [];
}
function numberOption(parsed, name) {
    const value = stringOption(parsed, name);
    if (value === undefined)
        return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0)
        throw new Error(`--${name} must be a non-negative number.`);
    return number;
}
function hasFlag(parsed, name) {
    return parsed.options.get(name) === true;
}
function captureOption(parsed) {
    const capture = stringOption(parsed, "capture") ?? process.env.CTXPROF_CAPTURE ?? "redacted";
    if (capture !== "none" && capture !== "redacted") {
        throw new Error("--capture must be `redacted` or `none`. Ctxprof intentionally has no unsafe full-capture mode.");
    }
    return capture;
}
function dataDirectory(parsed) {
    return stringOption(parsed, "data") ?? process.env.CTXPROF_DATA ?? ".ctxprof";
}
function requireFiles(parsed) {
    if (parsed.positionals.length === 0)
        throw new Error("Pass at least one .json, .jsonl, or .har file.");
}
function numberFromEnv(name) {
    const value = process.env[name];
    if (!value)
        return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0)
        throw new Error(`${name} must be a non-negative number.`);
    return number;
}
function portNumber(value) {
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535.");
    }
    return value;
}
function validateUpstream(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("--upstream must be a valid http:// or https:// URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("--upstream must use http:// or https://.");
    }
    if (url.username || url.password) {
        throw new Error("Do not put credentials in --upstream; use Authorization or OPENAI_API_KEY.");
    }
}
function assignNumber(target, key, value) {
    if (value !== undefined)
        target[key] = value;
}
async function exists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function waitForStop() {
    await new Promise((resolve) => {
        const stop = () => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
    });
}
function printHelp(command) {
    if (command === "proxy" || command === "serve") {
        process.stdout.write(`ctxprof ${command} [options]\n\n${command === "proxy" ? "Run the recording proxy and live dashboard." : "Serve the local capture dashboard without an upstream proxy."}\n\nOptions:\n  --host <address>               Bind address (default 127.0.0.1)\n  --port <n>                     Listen port (default 8787)\n  --allow-remote                 Permit a non-loopback bind\n  --allowed-host <hostname>      Allow an exact reverse-proxy Host (repeatable)\n${command === "proxy" ? "  --upstream <url>               OpenAI-compatible upstream URL\n  --upstream-timeout-ms <n>     Upstream deadline in milliseconds\n" : ""}  --data <dir>                   Store directory (default .ctxprof)\n  --capture redacted|none       Stored body policy (default redacted)\n  --help                         Show this help\n`);
        return;
    }
    if (command === "check") {
        process.stdout.write(`ctxprof check [files...] [options]\n\nFail CI when context tokens, cost, warnings, or components exceed limits or regress from a committed baseline.\n\nOptions:\n  --config <file>              Budget config (default ctxprof.config.json)\n  --baseline <file>            Override baseline path\n  --pricing <file>             Exact custom model pricing JSON\n  --update-baseline            Write the current metrics as baseline\n  --max-input-tokens <n>       Absolute input-token ceiling\n  --max-total-tokens <n>       Absolute input + output-token ceiling\n  --max-cost <usd>             Absolute estimated-cost ceiling\n  --max-warnings <n>           Absolute actionable-warning ceiling\n  --token-regression <pct>     Allowed input-token growth\n  --total-regression <pct>     Allowed total-token growth\n  --cost-regression <pct>      Allowed estimated-cost growth\n  --component-regression <pct> Allowed growth for every component kind\n  --github                     Emit GitHub workflow annotations\n  --json                       Machine-readable result\n  --help                       Show this help\n`);
        return;
    }
    process.stdout.write(`ctxprof ${VERSION} — the flamegraph for your context window\n\nUsage:\n  ctxprof <command> [options]\n\nCapture and inspect\n  proxy     Run an OpenAI-compatible recording proxy + dashboard\n  serve     View captures without enabling upstream proxying\n  import    Add HAR, JSON, or JSONL exchanges to the local store\n  analyze   Profile files without saving them\n  report    Export a self-contained interactive HTML report\n  demo      Load a deterministic A/B demo (no API key required)\n\nGuard and compare\n  compare   Compare aggregate prompt versions A → B\n  check     Run a context budget test for CI\n  pricing   Show the dated built-in pricing catalog\n  doctor    Check the local runtime and privacy defaults\n\nCommon options (where supported)\n  --data <dir>                 Store directory (default .ctxprof)\n  --pricing <file>             Exact custom model pricing JSON\n  --capture redacted|none      Stored body policy (default redacted)\n  --help                       Show help\n\nQuick start:\n  ctxprof demo\n  ctxprof serve\n\nProxy an app:\n  ctxprof proxy --upstream https://api.openai.com --port 8787\n  # point the SDK base URL to http://127.0.0.1:8787/v1\n`);
}
function line(name, value, suffix) {
    return `${name.padEnd(20)} ${value.padStart(12)}  ${suffix}`;
}
function signed(value) {
    return `${value >= 0 ? "+" : ""}${value.toLocaleString()}`;
}
function signedUsd(value) {
    return `${value >= 0 ? "+" : "-"}${usd(Math.abs(value))}`;
}
function percent(value) {
    return value === null ? "new" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
function usd(value) {
    return `$${value.toFixed(value < 0.01 ? 6 : 3)}`;
}
function formatNumber(value) {
    return value === null ? "unknown" : value.toLocaleString("en-US");
}
function escapeWorkflow(value) {
    return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
if (isDirectExecution()) {
    process.stdout.on("error", (error) => {
        if (error.code === "EPIPE")
            process.exit(0);
        throw error;
    });
    main().then((code) => {
        process.exitCode = code;
    }, (error) => {
        process.stderr.write(`ctxprof: ${safeError(error)}\n`);
        if (process.env.CTXPROF_DEBUG === "1" && error instanceof Error)
            process.stderr.write(`${error.stack ?? ""}\n`);
        process.exitCode = 1;
    });
}
function isDirectExecution() {
    if (!process.argv[1])
        return false;
    const entryPath = path.resolve(process.argv[1]);
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryPath);
    }
    catch {
        return import.meta.url === pathToFileURL(entryPath).href;
    }
}
//# sourceMappingURL=cli.js.map