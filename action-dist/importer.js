import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeExchange } from "./analyzer.js";
import { MAX_PROFILE_WARNINGS } from "./limits.js";
import { findPricing } from "./pricing.js";
import { contentHash, redactText, redactValue } from "./redaction.js";
import { isProfileRun } from "./store.js";
import { stableStringify } from "./tokenizer.js";
export async function importFile(filePath, options = {}) {
    const absolute = path.resolve(filePath);
    const contents = await readFile(absolute, "utf8");
    const modified = (await stat(absolute)).mtime.toISOString();
    const values = parseDocument(contents, path.extname(absolute).toLowerCase());
    const exchanges = values.flatMap(extractRecords);
    const baseName = path.basename(filePath);
    return exchanges.map((value, index) => {
        if (isProfileRun(value)) {
            const sanitized = sanitizeImportedRun(value, options.captureMode ?? "redacted");
            return {
                name: exchanges.length === 1 ? baseName : `${baseName}#${index + 1}`,
                run: applyImportedRunOverrides(sanitized, options),
            };
        }
        const analyzeOptions = {
            source: options.source ?? value.source ?? "import",
            captureMode: options.captureMode ?? "redacted",
            capturedAt: value.capturedAt ?? modified,
            pricing: options.pricing ?? [],
        };
        assignString(analyzeOptions, "label", options.label ?? value.label);
        assignString(analyzeOptions, "promptVersion", options.promptVersion ?? value.promptVersion);
        assignString(analyzeOptions, "model", options.model);
        assignString(analyzeOptions, "endpoint", value.endpoint);
        if (value.status !== undefined)
            analyzeOptions.status = value.status;
        if (value.durationMs !== undefined)
            analyzeOptions.durationMs = value.durationMs;
        return {
            name: exchanges.length === 1 ? baseName : `${baseName}#${index + 1}`,
            run: analyzeExchange(value.request, value.response, analyzeOptions),
        };
    });
}
function applyImportedRunOverrides(run, options) {
    const label = safeOverride(options.label, 200) ?? run.label;
    const promptVersion = safeOverride(options.promptVersion, 160) ?? run.promptVersion;
    const model = safeOverride(options.model, 200) ?? run.model;
    const overridden = {
        ...run,
        label,
        promptVersion,
        model,
        ...(options.source ? { source: options.source } : {}),
    };
    if (model === run.model && !(options.pricing?.length))
        return overridden;
    return repriceImportedRun(overridden, options.pricing ?? []);
}
function repriceImportedRun(run, additionalPricing) {
    const pricing = findPricing(run.model, additionalPricing);
    const inputTokens = run.totals.providerInputTokens ?? run.totals.estimatedInputTokens;
    const inputCost = pricing
        ? roundUsd((inputTokens / 1_000_000) * pricing.inputPerMillionUsd)
        : null;
    const outputCost = pricing
        ? roundUsd((run.totals.outputTokens / 1_000_000) * pricing.outputPerMillionUsd)
        : null;
    const warnings = run.warnings.filter((warning) => warning.code !== "unknown-pricing" && warning.code !== "context-pressure");
    if (!pricing) {
        appendImportedWarning(warnings, {
            code: "unknown-pricing",
            severity: "info",
            title: "Price is unknown for this model",
            detail: "Add an exact model entry to a pricing catalog instead of relying on a guessed alias.",
        });
    }
    else if (pricing.contextWindow && inputTokens / pricing.contextWindow >= 0.8) {
        appendImportedWarning(warnings, {
            code: "context-pressure",
            severity: inputTokens > pricing.contextWindow ? "critical" : "warning",
            title: "Context window is under pressure",
            detail: `${Math.round((inputTokens / pricing.contextWindow) * 100)}% of the cataloged context window is occupied by input.`,
        });
    }
    return {
        ...run,
        pricing,
        components: run.components.map((component) => ({
            ...component,
            estimatedCostUsd: pricing
                ? roundUsd((component.allocatedInputTokens / 1_000_000) * pricing.inputPerMillionUsd)
                : null,
        })),
        totals: {
            ...run.totals,
            estimatedInputCostUsd: inputCost,
            estimatedOutputCostUsd: outputCost,
            estimatedTotalCostUsd: inputCost === null || outputCost === null ? null : roundUsd(inputCost + outputCost),
        },
        warnings,
    };
}
function appendImportedWarning(warnings, warning) {
    if (warnings.length >= MAX_PROFILE_WARNINGS) {
        let removable = -1;
        for (let index = warnings.length - 1; index >= 0; index -= 1) {
            if (warnings[index]?.code !== "analysis-truncated") {
                removable = index;
                break;
            }
        }
        if (removable >= 0)
            warnings.splice(removable, 1);
        else
            warnings.pop();
    }
    warnings.push(warning);
}
function safeOverride(value, maxLength) {
    if (!value?.trim())
        return undefined;
    return redactText(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength) || undefined;
}
function roundUsd(value) {
    return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
function sanitizeImportedRun(run, captureMode) {
    const redacted = redactValue(run);
    const candidate = canonicalRun(redacted.value);
    if (captureMode === "none") {
        return {
            ...candidate,
            components: candidate.components.map((component) => ({ ...component, preview: null })),
            exchange: { request: null, response: null, captureMode: "none", truncated: false },
        };
    }
    const exchange = candidate.exchange;
    const serialized = stableStringify(exchange);
    if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
        return {
            ...candidate,
            exchange: {
                request: {
                    notice: "Imported capture exceeded the byte limit and was omitted.",
                    contentHash: contentHash(stableStringify(run.exchange ?? null)),
                },
                response: null,
                captureMode: "redacted",
                truncated: true,
            },
        };
    }
    return {
        ...candidate,
        exchange: {
            request: exchange.request ?? null,
            response: exchange.response ?? null,
            captureMode: "redacted",
            truncated: Boolean(exchange.truncated || redacted.truncated),
        },
    };
}
function parseDocument(contents, extension) {
    if (extension === ".jsonl" || extension === ".ndjson") {
        const values = [];
        for (const [index, line] of contents.split(/\r?\n/).entries()) {
            if (!line.trim())
                continue;
            try {
                values.push(JSON.parse(line));
            }
            catch (error) {
                throw new Error(`Invalid JSON on line ${index + 1}: ${errorMessage(error)}`);
            }
        }
        return values;
    }
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed) ? parsed : [parsed];
}
function extractRecords(value) {
    if (isProfileRun(value))
        return [value];
    if (!isRecord(value))
        return [{ request: value, response: null }];
    if (looksLikeProfileRun(value)) {
        throw new Error("Invalid ProfileRun schema. Normalized runs must contain finite, internally consistent v1 fields.");
    }
    if (isRecord(value.log) && Array.isArray(value.log.entries)) {
        return value.log.entries.flatMap(extractHarEntry);
    }
    if (Array.isArray(value.runs))
        return value.runs.flatMap(extractRecords);
    // OpenAI Batch API JSONL request/response shape.
    if (isRecord(value.body) && typeof value.url === "string") {
        return [
            {
                request: value.body,
                response: null,
                endpoint: value.url,
                label: typeof value.custom_id === "string" ? value.custom_id : undefined,
            },
        ];
    }
    if (isRecord(value.request) || value.request !== undefined) {
        const metadata = isRecord(value.metadata) ? value.metadata : {};
        const responseWrapper = isRecord(value.response) && isRecord(value.response.body)
            ? value.response.body
            : value.response ?? null;
        return [
            withoutUndefined({
                request: isRecord(value.request) && isRecord(value.request.body) ? value.request.body : value.request,
                response: responseWrapper,
                endpoint: stringValue(value.endpoint) ?? stringValue(value.request?.url),
                status: statusValue(value.status, "status") ??
                    statusValue(value.response?.status_code, "response.status_code"),
                durationMs: durationValue(value.duration_ms, "duration_ms") ??
                    durationValue(metadata.duration_ms, "metadata.duration_ms"),
                capturedAt: stringValue(value.captured_at) ?? stringValue(metadata.captured_at),
                label: stringValue(value.label) ?? stringValue(metadata.label),
                promptVersion: stringValue(value.prompt_version) ?? stringValue(metadata.prompt_version),
            }),
        ];
    }
    return [{ request: value, response: null }];
}
function looksLikeProfileRun(value) {
    return value.schemaVersion === 1 &&
        typeof value.id === "string" &&
        (Array.isArray(value.components) || value.totals !== undefined);
}
function canonicalRun(run) {
    return {
        schemaVersion: run.schemaVersion,
        id: run.id,
        capturedAt: run.capturedAt,
        durationMs: run.durationMs,
        endpoint: run.endpoint,
        status: run.status,
        model: run.model,
        label: run.label,
        promptVersion: run.promptVersion,
        source: run.source,
        tokenizer: { ...run.tokenizer },
        pricing: run.pricing ? { ...run.pricing } : null,
        components: run.components.map((component) => ({ ...component })),
        totals: { ...run.totals },
        warnings: run.warnings.map((warning) => ({ ...warning })),
        exchange: {
            request: run.exchange.request,
            response: run.exchange.response,
            captureMode: run.exchange.captureMode,
            truncated: run.exchange.truncated,
        },
    };
}
function extractHarEntry(entry) {
    if (!isRecord(entry) || !isRecord(entry.request))
        return [];
    const requestText = isRecord(entry.request.postData) ? entry.request.postData.text : undefined;
    if (typeof requestText !== "string")
        return [];
    let request;
    try {
        request = JSON.parse(requestText);
    }
    catch {
        return [];
    }
    let response = null;
    if (isRecord(entry.response) && isRecord(entry.response.content) && typeof entry.response.content.text === "string") {
        const raw = entry.response.content.encoding === "base64"
            ? Buffer.from(entry.response.content.text, "base64").toString("utf8")
            : entry.response.content.text;
        try {
            response = JSON.parse(raw);
        }
        catch {
            response = { text: raw };
        }
    }
    return [
        withoutUndefined({
            request,
            response,
            endpoint: stringValue(entry.request.url),
            status: isRecord(entry.response) ? statusValue(entry.response.status, "HAR response.status") : undefined,
            durationMs: durationValue(entry.time, "HAR entry.time"),
            capturedAt: stringValue(entry.startedDateTime),
        }),
    ];
}
function withoutUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}
function assignString(target, key, value) {
    if (typeof value === "string" && value.length > 0) {
        target[key] = value;
    }
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function statusValue(value, field) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
        return value;
    throw new Error(`${field} must be null or a finite non-negative integer.`);
}
function durationValue(value, field) {
    if (value === undefined)
        return undefined;
    if (value === null)
        return null;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return value;
    throw new Error(`${field} must be null or a finite non-negative number.`);
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=importer.js.map