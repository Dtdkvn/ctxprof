import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeExchange } from "./analyzer.js";
import { contentHash, redactValue } from "./redaction.js";
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
            return {
                name: exchanges.length === 1 ? baseName : `${baseName}#${index + 1}`,
                run: sanitizeImportedRun(value, options.captureMode ?? "redacted"),
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
                status: numberValue(value.status) ?? numberValue(value.response?.status_code),
                durationMs: numberValue(value.duration_ms) ?? numberValue(metadata.duration_ms),
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
            status: isRecord(entry.response) ? numberValue(entry.response.status) : undefined,
            durationMs: numberValue(entry.time),
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
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=importer.js.map