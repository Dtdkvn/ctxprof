import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isProfileRun } from "./store.js";
const COMPONENT_KINDS = [
    "system",
    "developer",
    "tools",
    "message",
    "tool_result",
    "other",
];
export function metricsForRuns(runs) {
    const cases = Object.create(null);
    for (const named of runs) {
        if (!isProfileRun(named.run)) {
            throw new Error(`Invalid ProfileRun â€œ${named.name}â€: metrics are not finite and internally consistent.`);
        }
        let name = named.name;
        let suffix = 2;
        while (Object.hasOwn(cases, name))
            name = `${named.name}#${suffix++}`;
        const components = emptyComponents();
        if (!Array.isArray(named.run.components) || !Array.isArray(named.run.warnings)) {
            throw new Error(`Invalid ProfileRun “${named.name}”: components and warnings must be arrays.`);
        }
        for (const component of named.run.components) {
            if (!COMPONENT_KINDS.includes(component.kind)) {
                throw new Error(`Invalid ProfileRun “${named.name}”: unknown component kind.`);
            }
            components[component.kind] += requireRunMetric(component.allocatedInputTokens, named.name, `components.${component.kind}`);
        }
        const inputTokens = requireRunMetric(named.run.totals.providerInputTokens ?? named.run.totals.estimatedInputTokens, named.name, "inputTokens");
        const totalTokens = requireRunMetric(named.run.totals.totalTokens, named.name, "totalTokens");
        const estimatedCostUsd = named.run.totals.estimatedTotalCostUsd;
        if (estimatedCostUsd !== null)
            requireRunMetric(estimatedCostUsd, named.name, "estimatedCostUsd");
        cases[name] = {
            inputTokens,
            totalTokens,
            estimatedCostUsd: named.run.totals.estimatedTotalCostUsd,
            components,
            warnings: named.run.warnings.filter((warning) => warning.severity !== "info").length,
        };
    }
    return cases;
}
function requireRunMetric(value, caseName, metric) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid ProfileRun “${caseName}”: ${metric} must be a finite non-negative number.`);
    }
    return value;
}
export function evaluateBudget(cases, config, baseline) {
    const violations = [];
    for (const [caseName, metrics] of Object.entries(cases)) {
        applyAbsoluteLimits(caseName, metrics, config, violations);
        const prior = baseline?.cases[caseName];
        if (prior) {
            applyRegressionLimits(caseName, metrics, prior, config, violations);
        }
        else if (baseline && hasRegressionLimits(config)) {
            violations.push({
                caseName,
                metric: "case",
                actual: 1,
                allowed: 0,
                message: "Current case is missing from the committed baseline. Review it and update the baseline intentionally.",
            });
        }
    }
    if (baseline) {
        for (const caseName of Object.keys(baseline.cases)) {
            if (!cases[caseName]) {
                violations.push({
                    caseName,
                    metric: "case",
                    actual: 0,
                    allowed: 1,
                    message: "Baseline case is missing from current inputs.",
                });
            }
        }
    }
    return { passed: violations.length === 0, cases, violations };
}
export function makeBaseline(cases) {
    return { schemaVersion: 1, generatedAt: new Date().toISOString(), cases };
}
export async function readBudgetConfig(filePath) {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Budget config must be a JSON object.");
    }
    return validateBudgetConfig(value);
}
export async function readBaseline(filePath) {
    try {
        const value = JSON.parse(await readFile(filePath, "utf8"));
        return validateBaseline(value);
    }
    catch (error) {
        if (isNotFound(error))
            return null;
        throw error;
    }
}
function validateBaseline(value) {
    const root = requireRecord(value, "baseline");
    if (root.schemaVersion !== 1)
        throw new Error("Unsupported baseline schema.");
    if (typeof root.generatedAt !== "string" || root.generatedAt.length === 0) {
        throw new Error("baseline.generatedAt must be a non-empty string.");
    }
    const rawCases = requireRecord(root.cases, "baseline.cases");
    const cases = Object.create(null);
    for (const [caseName, rawMetrics] of Object.entries(rawCases)) {
        const metrics = requireRecord(rawMetrics, `baseline.cases.${caseName}`);
        const rawComponents = requireRecord(metrics.components, `baseline.cases.${caseName}.components`);
        const components = emptyComponents();
        for (const kind of COMPONENT_KINDS) {
            components[kind] = requireNonnegativeNumber(rawComponents[kind], `baseline.cases.${caseName}.components.${kind}`);
        }
        const rawCost = metrics.estimatedCostUsd;
        if (rawCost !== null && (typeof rawCost !== "number" || !Number.isFinite(rawCost) || rawCost < 0)) {
            throw new Error(`baseline.cases.${caseName}.estimatedCostUsd must be null or a non-negative number.`);
        }
        cases[caseName] = {
            inputTokens: requireNonnegativeNumber(metrics.inputTokens, `baseline.cases.${caseName}.inputTokens`),
            totalTokens: requireNonnegativeNumber(metrics.totalTokens, `baseline.cases.${caseName}.totalTokens`),
            estimatedCostUsd: rawCost,
            components,
            warnings: requireNonnegativeNumber(metrics.warnings, `baseline.cases.${caseName}.warnings`),
        };
    }
    return { schemaVersion: 1, generatedAt: root.generatedAt, cases };
}
export async function writeBaseline(filePath, baseline) {
    await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}
function validateBudgetConfig(value) {
    rejectUnknownKeys(value, new Set(["$schema", "input", "baseline", "limits", "regressions"]), "config");
    const config = {};
    if (value.input !== undefined) {
        if (!Array.isArray(value.input) || value.input.length === 0 || value.input.some((entry) => typeof entry !== "string" || !entry)) {
            throw new Error("config.input must be a non-empty array of file paths.");
        }
        config.input = [...value.input];
    }
    if (value.baseline !== undefined) {
        if (typeof value.baseline !== "string" || !value.baseline) {
            throw new Error("config.baseline must be a file path.");
        }
        config.baseline = value.baseline;
    }
    if (value.limits !== undefined) {
        const limits = requireRecord(value.limits, "config.limits");
        rejectUnknownKeys(limits, new Set(["inputTokens", "totalTokens", "estimatedCostUsd", "warnings", "components"]), "config.limits");
        config.limits = {
            ...optionalNumberFields(limits, ["inputTokens", "totalTokens", "estimatedCostUsd", "warnings"], "config.limits"),
        };
        if (limits.components !== undefined) {
            const components = requireRecord(limits.components, "config.limits.components");
            rejectUnknownKeys(components, new Set(COMPONENT_KINDS), "config.limits.components");
            config.limits.components = optionalNumberFields(components, COMPONENT_KINDS, "config.limits.components");
        }
    }
    if (value.regressions !== undefined) {
        const regressions = requireRecord(value.regressions, "config.regressions");
        const fields = [
            "inputTokensPercent",
            "totalTokensPercent",
            "estimatedCostPercent",
            "componentPercent",
            "warningsIncrease",
        ];
        rejectUnknownKeys(regressions, new Set(fields), "config.regressions");
        config.regressions = optionalNumberFields(regressions, fields, "config.regressions");
    }
    return config;
}
function optionalNumberFields(value, fields, location) {
    const result = {};
    for (const field of fields) {
        const candidate = value[field];
        if (candidate === undefined)
            continue;
        if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
            throw new Error(`${location}.${field} must be a non-negative number.`);
        }
        result[field] = candidate;
    }
    return result;
}
function requireRecord(value, location) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${location} must be an object.`);
    }
    return value;
}
function rejectUnknownKeys(value, allowed, location) {
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown)
        throw new Error(`${location} contains unknown field “${unknown}”.`);
}
function requireNonnegativeNumber(value, location) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${location} must be a non-negative number.`);
    }
    return value;
}
function hasRegressionLimits(config) {
    return Boolean(config.regressions && Object.values(config.regressions).some((value) => value !== undefined));
}
function applyAbsoluteLimits(caseName, metrics, config, violations) {
    const limits = config.limits;
    if (!limits)
        return;
    compareMax(caseName, "inputTokens", metrics.inputTokens, limits.inputTokens, violations);
    compareMax(caseName, "totalTokens", metrics.totalTokens, limits.totalTokens, violations);
    compareMax(caseName, "warnings", metrics.warnings, limits.warnings, violations);
    if (limits.estimatedCostUsd !== undefined) {
        if (metrics.estimatedCostUsd === null) {
            violations.push({
                caseName,
                metric: "estimatedCostUsd",
                actual: 0,
                allowed: limits.estimatedCostUsd,
                message: "Cannot evaluate the cost limit because this model has no exact pricing record.",
            });
        }
        else {
            compareMax(caseName, "estimatedCostUsd", metrics.estimatedCostUsd, limits.estimatedCostUsd, violations);
        }
    }
    for (const kind of COMPONENT_KINDS) {
        compareMax(caseName, `components.${kind}`, metrics.components[kind], limits.components?.[kind], violations);
    }
}
function applyRegressionLimits(caseName, current, prior, config, violations) {
    const regressions = config.regressions;
    if (!regressions)
        return;
    compareRegression(caseName, "inputTokens regression", current.inputTokens, prior.inputTokens, regressions.inputTokensPercent, violations);
    compareRegression(caseName, "totalTokens regression", current.totalTokens, prior.totalTokens, regressions.totalTokensPercent, violations);
    if (regressions.estimatedCostPercent !== undefined) {
        if (current.estimatedCostUsd === null || prior.estimatedCostUsd === null) {
            violations.push({
                caseName,
                metric: "cost regression",
                actual: current.estimatedCostUsd ?? 0,
                allowed: prior.estimatedCostUsd ?? 0,
                message: "Cannot compare cost regression because current or baseline pricing is unknown.",
            });
        }
        else {
            compareRegression(caseName, "cost regression", current.estimatedCostUsd, prior.estimatedCostUsd, regressions.estimatedCostPercent, violations);
        }
    }
    for (const kind of COMPONENT_KINDS) {
        compareRegression(caseName, `${kind} component regression`, current.components[kind], prior.components[kind], regressions.componentPercent, violations);
    }
    if (regressions.warningsIncrease !== undefined) {
        compareMax(caseName, "warnings regression", current.warnings, prior.warnings + regressions.warningsIncrease, violations);
    }
}
function compareMax(caseName, metric, actual, allowed, violations) {
    if (allowed !== undefined && actual > allowed) {
        violations.push({
            caseName,
            metric,
            actual,
            allowed,
            message: `${metric} is ${format(actual)}, above the allowed ${format(allowed)}.`,
        });
    }
}
function compareRegression(caseName, metric, actual, prior, allowedPercent, violations) {
    if (allowedPercent === undefined)
        return;
    const allowed = prior === 0 ? 0 : prior * (1 + allowedPercent / 100);
    if (actual > allowed) {
        const percent = prior === 0 ? "new non-zero value" : `${(((actual - prior) / prior) * 100).toFixed(1)}%`;
        violations.push({
            caseName,
            metric,
            actual,
            allowed,
            message: `${metric} grew by ${percent}; allowed regression is ${allowedPercent}%.`,
        });
    }
}
function emptyComponents() {
    return { system: 0, developer: 0, tools: 0, message: 0, tool_result: 0, other: 0 };
}
function format(value) {
    return Number.isInteger(value) ? value.toLocaleString() : value.toPrecision(5);
}
function isNotFound(error) {
    return Boolean(error) && typeof error === "object" && error.code === "ENOENT";
}
//# sourceMappingURL=budget.js.map