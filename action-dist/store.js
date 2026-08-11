import { appendFile, chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_PROFILE_COMPONENTS, MAX_PROFILE_RUN_BYTES, MAX_PROFILE_WARNINGS } from "./limits.js";
import { MAX_PRICING_RATE_USD_PER_MILLION } from "./pricing.js";
const COMPONENT_KINDS = new Set(["system", "developer", "tools", "message", "tool_result", "other"]);
const WARNING_CODES = new Set([
    "unused-tool",
    "large-tool-result",
    "dominant-system-prompt",
    "duplicate-context",
    "context-pressure",
    "unknown-pricing",
    "large-tool-schema",
    "invalid-provider-usage",
    "analysis-truncated",
    "truncated-response",
]);
const WARNING_SEVERITIES = new Set(["info", "warning", "critical"]);
const RUN_SOURCES = new Set(["proxy", "import", "fixture"]);
const TAIL_SCAN_CHUNK_BYTES = 64 * 1024;
export class RunStore {
    directory;
    runsFile;
    writeQueue = Promise.resolve();
    constructor(directory = ".ctxprof") {
        this.directory = path.resolve(directory);
        this.runsFile = path.join(this.directory, "runs.jsonl");
    }
    async init() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await bestEffortChmod(this.directory, 0o700);
    }
    async append(run) {
        await this.init();
        const payload = serializeRun(run);
        await this.enqueue(async () => {
            const separator = await prepareRunsFileForAppend(this.runsFile);
            await appendFile(this.runsFile, `${separator}${payload}\n`, { encoding: "utf8", mode: 0o600 });
            await bestEffortChmod(this.runsFile, 0o600);
        });
    }
    async appendMany(runs) {
        if (runs.length === 0)
            return;
        await this.init();
        const payload = runs.map(serializeRun).join("\n") + "\n";
        await this.enqueue(async () => {
            const separator = await prepareRunsFileForAppend(this.runsFile);
            await appendFile(this.runsFile, `${separator}${payload}`, { encoding: "utf8", mode: 0o600 });
            await bestEffortChmod(this.runsFile, 0o600);
        });
    }
    async list(limit = 1_000) {
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new Error("RunStore.list limit must be a non-negative safe integer.");
        }
        if (limit === 0)
            return [];
        await this.writeQueue;
        let contents;
        try {
            contents = await readFile(this.runsFile, "utf8");
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw error;
        }
        const runs = [];
        const lines = contents.split(/\r?\n/);
        let lastNonemptyIndex = -1;
        for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (lines[index]?.trim()) {
                lastNonemptyIndex = index;
                break;
            }
        }
        for (const [index, line] of lines.entries()) {
            if (!line.trim())
                continue;
            let value;
            try {
                value = JSON.parse(line);
            }
            catch (error) {
                if (index === lastNonemptyIndex)
                    break;
                throw new Error(`Invalid JSON in ${this.runsFile}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (!isProfileRun(value)) {
                throw new Error(`Invalid ProfileRun in ${this.runsFile}:${index + 1}.`);
            }
            runs.push(value);
        }
        return runs.slice(-limit).reverse();
    }
    async sizeBytes() {
        try {
            return (await stat(this.runsFile)).size;
        }
        catch (error) {
            if (isNotFound(error))
                return 0;
            throw error;
        }
    }
    async revision() {
        await this.writeQueue;
        try {
            const metadata = await stat(this.runsFile, { bigint: true });
            return `${metadata.size.toString(36)}-${metadata.mtimeNs.toString(36)}`;
        }
        catch (error) {
            if (isNotFound(error))
                return "0-0";
            throw error;
        }
    }
    async enqueue(operation) {
        const current = this.writeQueue.then(operation, operation);
        // Keep the internal queue usable after a failed write while returning the
        // original failure to the caller that attempted it.
        this.writeQueue = current.catch(() => undefined);
        await current;
    }
}
async function prepareRunsFileForAppend(runsFile) {
    let handle;
    try {
        handle = await open(runsFile, "r+");
    }
    catch (error) {
        if (isNotFound(error))
            return "";
        throw error;
    }
    try {
        const metadata = await handle.stat();
        if (metadata.size === 0)
            return "";
        const bounds = await findLastNonemptyLine(handle, metadata.size);
        if (bounds) {
            const length = bounds.end - bounds.start;
            if (length > MAX_PROFILE_RUN_BYTES) {
                throw new Error(`Refusing to append because the trailing JSONL record is ${length} bytes; ` +
                    `the safe inspection limit is ${MAX_PROFILE_RUN_BYTES} bytes.`);
            }
            const bytes = Buffer.allocUnsafe(length);
            const result = await handle.read(bytes, 0, length, bounds.start);
            if (result.bytesRead !== length) {
                throw new Error(`Could not inspect the trailing JSONL record in ${runsFile}.`);
            }
            try {
                JSON.parse(bytes.toString("utf8"));
            }
            catch {
                await handle.truncate(bounds.start);
                return "";
            }
        }
        const finalByte = Buffer.allocUnsafe(1);
        const result = await handle.read(finalByte, 0, 1, metadata.size - 1);
        if (result.bytesRead !== 1) {
            throw new Error(`Could not inspect the end of ${runsFile}.`);
        }
        return finalByte[0] === 0x0a ? "" : "\n";
    }
    finally {
        await handle.close();
    }
}
async function findLastNonemptyLine(handle, size) {
    let cursor = size;
    let end = -1;
    while (cursor > 0) {
        const start = Math.max(0, cursor - TAIL_SCAN_CHUNK_BYTES);
        const length = cursor - start;
        const bytes = Buffer.allocUnsafe(length);
        const result = await handle.read(bytes, 0, length, start);
        if (result.bytesRead !== length) {
            throw new Error("Could not scan the trailing JSONL record.");
        }
        for (let index = length - 1; index >= 0; index -= 1) {
            const byte = bytes[index];
            if (byte === undefined)
                continue;
            const position = start + index;
            if (end < 0) {
                if (isJsonlWhitespace(byte))
                    continue;
                end = position + 1;
            }
            else if (byte === 0x0a) {
                return { start: position + 1, end };
            }
        }
        cursor = start;
    }
    return end < 0 ? null : { start: 0, end };
}
function isJsonlWhitespace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
export function isProfileRun(value) {
    if (!isRecord(value))
        return false;
    const run = value;
    if (run.schemaVersion !== 1 ||
        !isNonemptyString(run.id) ||
        !isNonemptyString(run.capturedAt) ||
        !isNullableNonnegativeNumber(run.durationMs) ||
        !isNonemptyString(run.endpoint) ||
        !isNullableNonnegativeInteger(run.status) ||
        !isNonemptyString(run.model) ||
        !isNonemptyString(run.label) ||
        !isNonemptyString(run.promptVersion) ||
        typeof run.source !== "string" ||
        !RUN_SOURCES.has(run.source) ||
        !isTokenizer(run.tokenizer) ||
        !isPricing(run.pricing) ||
        !Array.isArray(run.components) ||
        run.components.length === 0 ||
        run.components.length > MAX_PROFILE_COMPONENTS ||
        !run.components.every(isComponent) ||
        !isTotals(run.totals) ||
        !Array.isArray(run.warnings) ||
        run.warnings.length > MAX_PROFILE_WARNINGS ||
        !run.warnings.every(isWarning) ||
        !isExchange(run.exchange)) {
        return false;
    }
    const components = run.components;
    const totals = run.totals;
    const estimated = components.reduce((sum, component) => sum + Number(component.estimatedTokens), 0);
    const allocated = components.reduce((sum, component) => sum + Number(component.allocatedInputTokens), 0);
    const displayedInput = totals.providerInputTokens ?? totals.estimatedInputTokens;
    const share = components.reduce((sum, component) => sum + Number(component.share), 0);
    return (estimated === totals.estimatedInputTokens &&
        allocated === displayedInput &&
        totals.totalTokens === Number(displayedInput) + Number(totals.outputTokens) &&
        Math.abs(share - 1) < 1e-6 &&
        isCostConsistent(run, Number(displayedInput)) &&
        isWithinSerializedRunLimit(run));
}
function isWithinSerializedRunLimit(run) {
    try {
        return Buffer.byteLength(JSON.stringify(run), "utf8") <= MAX_PROFILE_RUN_BYTES;
    }
    catch {
        return false;
    }
}
function serializeRun(run) {
    let serialized;
    try {
        serialized = JSON.stringify(run);
    }
    catch {
        throw new Error("Refusing to store an invalid ProfileRun.");
    }
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_PROFILE_RUN_BYTES) {
        throw new Error(`Refusing to store a ${bytes}-byte ProfileRun; the limit is ${MAX_PROFILE_RUN_BYTES} bytes.`);
    }
    if (!isProfileRun(run)) {
        throw new Error("Refusing to store an invalid ProfileRun.");
    }
    return serialized;
}
function isCostConsistent(run, displayedInput) {
    const totals = run.totals;
    const components = run.components;
    if (run.pricing === null) {
        return totals.estimatedInputCostUsd === null &&
            totals.estimatedOutputCostUsd === null &&
            totals.estimatedTotalCostUsd === null &&
            components.every((component) => component.estimatedCostUsd === null);
    }
    if (!isRecord(run.pricing) ||
        String(run.pricing.model).trim().toLowerCase() !== String(run.model).trim().toLowerCase())
        return false;
    const inputCost = roundUsd((displayedInput / 1_000_000) * Number(run.pricing.inputPerMillionUsd));
    const outputCost = roundUsd((Number(totals.outputTokens) / 1_000_000) * Number(run.pricing.outputPerMillionUsd));
    if (!withinRoundedUsd(totals.estimatedInputCostUsd, inputCost) ||
        !withinRoundedUsd(totals.estimatedOutputCostUsd, outputCost) ||
        !withinRoundedUsd(totals.estimatedTotalCostUsd, roundUsd(inputCost + outputCost))) {
        return false;
    }
    return components.every((component) => withinRoundedUsd(component.estimatedCostUsd, roundUsd((Number(component.allocatedInputTokens) / 1_000_000) *
        Number(run.pricing.inputPerMillionUsd))));
}
function withinRoundedUsd(value, expected) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value - expected) <= 0.000000000501;
}
function roundUsd(value) {
    return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
function isTokenizer(value) {
    return isRecord(value) &&
        value.method === "utf8-byte-estimate-v1" &&
        value.exact === false &&
        typeof value.note === "string";
}
function isPricing(value) {
    if (value === null)
        return true;
    return isRecord(value) &&
        isNonemptyString(value.model) &&
        isPricingRate(value.inputPerMillionUsd) &&
        isPricingRate(value.outputPerMillionUsd) &&
        (value.contextWindow === null || isPositiveInteger(value.contextWindow)) &&
        isNonemptyString(value.source) &&
        isNonemptyString(value.checkedAt);
}
function isPricingRate(value) {
    return isNonnegativeNumber(value) && value <= MAX_PRICING_RATE_USD_PER_MILLION;
}
function isComponent(value) {
    return isRecord(value) &&
        isNonemptyString(value.id) &&
        typeof value.kind === "string" &&
        COMPONENT_KINDS.has(value.kind) &&
        isNonemptyString(value.label) &&
        isNonnegativeInteger(value.estimatedTokens) &&
        isNonnegativeInteger(value.allocatedInputTokens) &&
        isNonnegativeInteger(value.bytes) &&
        isNonnegativeNumber(value.share) &&
        value.share <= 1 &&
        (value.estimatedCostUsd === null || isNonnegativeNumber(value.estimatedCostUsd)) &&
        isNonemptyString(value.contentHash) &&
        (value.preview === null || typeof value.preview === "string");
}
function isTotals(value) {
    return isRecord(value) &&
        isNonnegativeInteger(value.estimatedInputTokens) &&
        (value.providerInputTokens === null || isNonnegativeInteger(value.providerInputTokens)) &&
        isNonnegativeInteger(value.outputTokens) &&
        isNonnegativeInteger(value.totalTokens) &&
        (value.estimatedInputCostUsd === null || isNonnegativeNumber(value.estimatedInputCostUsd)) &&
        (value.estimatedOutputCostUsd === null || isNonnegativeNumber(value.estimatedOutputCostUsd)) &&
        (value.estimatedTotalCostUsd === null || isNonnegativeNumber(value.estimatedTotalCostUsd)) &&
        isNonnegativeInteger(value.estimatedWasteTokens);
}
function isWarning(value) {
    if (!isRecord(value) || typeof value.code !== "string" || !WARNING_CODES.has(value.code))
        return false;
    if (typeof value.severity !== "string" || !WARNING_SEVERITIES.has(value.severity))
        return false;
    if (!isNonemptyString(value.title) || !isNonemptyString(value.detail))
        return false;
    if (value.componentId !== undefined && typeof value.componentId !== "string")
        return false;
    return value.estimatedWasteTokens === undefined || isNonnegativeInteger(value.estimatedWasteTokens);
}
function isExchange(value) {
    return isRecord(value) &&
        (value.captureMode === "none" || value.captureMode === "redacted") &&
        typeof value.truncated === "boolean" &&
        Object.hasOwn(value, "request") &&
        Object.hasOwn(value, "response");
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNonemptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isNonnegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isNonnegativeInteger(value) {
    return isNonnegativeNumber(value) && Number.isSafeInteger(value);
}
function isPositiveInteger(value) {
    return isNonnegativeInteger(value) && value > 0;
}
function isNullableNonnegativeNumber(value) {
    return value === null || isNonnegativeNumber(value);
}
function isNullableNonnegativeInteger(value) {
    return value === null || isNonnegativeInteger(value);
}
async function bestEffortChmod(target, mode) {
    try {
        await chmod(target, mode);
    }
    catch {
        // Windows ACLs and some mounted filesystems do not expose POSIX modes.
    }
}
function isNotFound(error) {
    return Boolean(error) && typeof error === "object" && error.code === "ENOENT";
}
//# sourceMappingURL=store.js.map