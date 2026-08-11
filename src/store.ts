import { appendFile, chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_PROFILE_COMPONENTS, MAX_PROFILE_RUN_BYTES, MAX_PROFILE_WARNINGS } from "./limits.js";
import type { ProfileRun } from "./types.js";

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

export class RunStore {
  readonly directory: string;
  readonly runsFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory = ".ctxprof") {
    this.directory = path.resolve(directory);
    this.runsFile = path.join(this.directory, "runs.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await bestEffortChmod(this.directory, 0o700);
  }

  async append(run: ProfileRun): Promise<void> {
    await this.init();
    const payload = serializeRun(run);
    await this.enqueue(async () => {
      await appendFile(this.runsFile, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
      await bestEffortChmod(this.runsFile, 0o600);
    });
  }

  async appendMany(runs: readonly ProfileRun[]): Promise<void> {
    if (runs.length === 0) return;
    await this.init();
    const payload = runs.map(serializeRun).join("\n") + "\n";
    await this.enqueue(async () => {
      await appendFile(this.runsFile, payload, { encoding: "utf8", mode: 0o600 });
      await bestEffortChmod(this.runsFile, 0o600);
    });
  }

  async list(limit = 1_000): Promise<ProfileRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("RunStore.list limit must be a non-negative safe integer.");
    }
    if (limit === 0) return [];
    await this.writeQueue;
    let contents: string;
    try {
      contents = await readFile(this.runsFile, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const runs: ProfileRun[] = [];
    const lines = contents.split(/\r?\n/);
    let lastNonemptyIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index]?.trim()) {
        lastNonemptyIndex = index;
        break;
      }
    }
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        if (index === lastNonemptyIndex) break;
        throw new Error(
          `Invalid JSON in ${this.runsFile}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isProfileRun(value)) {
        throw new Error(`Invalid ProfileRun in ${this.runsFile}:${index + 1}.`);
      }
      runs.push(value);
    }
    return runs.slice(-limit).reverse();
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.runsFile)).size;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.writeQueue.then(operation, operation);
    // Keep the internal queue usable after a failed write while returning the
    // original failure to the caller that attempted it.
    this.writeQueue = current.catch(() => undefined);
    await current;
  }
}

export function isProfileRun(value: unknown): value is ProfileRun {
  if (!isRecord(value)) return false;
  const run = value;
  if (
    run.schemaVersion !== 1 ||
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
    !isExchange(run.exchange)
  ) {
    return false;
  }

  const components = run.components as Array<Record<string, unknown>>;
  const totals = run.totals as Record<string, unknown>;
  const estimated = components.reduce((sum, component) => sum + Number(component.estimatedTokens), 0);
  const allocated = components.reduce((sum, component) => sum + Number(component.allocatedInputTokens), 0);
  const displayedInput = totals.providerInputTokens ?? totals.estimatedInputTokens;
  const share = components.reduce((sum, component) => sum + Number(component.share), 0);
  return (
    estimated === totals.estimatedInputTokens &&
    allocated === displayedInput &&
    totals.totalTokens === Number(displayedInput) + Number(totals.outputTokens) &&
    Math.abs(share - 1) < 1e-6 &&
    isCostConsistent(run, Number(displayedInput)) &&
    isWithinSerializedRunLimit(run)
  );
}

function isWithinSerializedRunLimit(run: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(run), "utf8") <= MAX_PROFILE_RUN_BYTES;
  } catch {
    return false;
  }
}

function serializeRun(run: ProfileRun): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(run);
  } catch {
    throw new Error("Refusing to store an invalid ProfileRun.");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_PROFILE_RUN_BYTES) {
    throw new Error(
      `Refusing to store a ${bytes}-byte ProfileRun; the limit is ${MAX_PROFILE_RUN_BYTES} bytes.`,
    );
  }
  if (!isProfileRun(run)) {
    throw new Error("Refusing to store an invalid ProfileRun.");
  }
  return serialized;
}

function isCostConsistent(run: Record<string, unknown>, displayedInput: number): boolean {
  const totals = run.totals as Record<string, unknown>;
  const components = run.components as Array<Record<string, unknown>>;
  if (run.pricing === null) {
    return totals.estimatedInputCostUsd === null &&
      totals.estimatedOutputCostUsd === null &&
      totals.estimatedTotalCostUsd === null &&
      components.every((component) => component.estimatedCostUsd === null);
  }
  if (
    !isRecord(run.pricing) ||
    String(run.pricing.model).trim().toLowerCase() !== String(run.model).trim().toLowerCase()
  ) return false;
  const inputCost = roundUsd((displayedInput / 1_000_000) * Number(run.pricing.inputPerMillionUsd));
  const outputCost = roundUsd(
    (Number(totals.outputTokens) / 1_000_000) * Number(run.pricing.outputPerMillionUsd),
  );
  if (
    !withinRoundedUsd(totals.estimatedInputCostUsd, inputCost) ||
    !withinRoundedUsd(totals.estimatedOutputCostUsd, outputCost) ||
    !withinRoundedUsd(totals.estimatedTotalCostUsd, roundUsd(inputCost + outputCost))
  ) {
    return false;
  }
  return components.every((component) => withinRoundedUsd(
    component.estimatedCostUsd,
    roundUsd(
      (Number(component.allocatedInputTokens) / 1_000_000) *
      Number((run.pricing as Record<string, unknown>).inputPerMillionUsd),
    ),
  ));
}

function withinRoundedUsd(value: unknown, expected: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value - expected) <= 0.000000000501;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function isTokenizer(value: unknown): boolean {
  return isRecord(value) &&
    value.method === "utf8-byte-estimate-v1" &&
    value.exact === false &&
    typeof value.note === "string";
}

function isPricing(value: unknown): boolean {
  if (value === null) return true;
  return isRecord(value) &&
    isNonemptyString(value.model) &&
    isNonnegativeNumber(value.inputPerMillionUsd) &&
    isNonnegativeNumber(value.outputPerMillionUsd) &&
    (value.contextWindow === null || isPositiveInteger(value.contextWindow)) &&
    isNonemptyString(value.source) &&
    isNonemptyString(value.checkedAt);
}

function isComponent(value: unknown): boolean {
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

function isTotals(value: unknown): boolean {
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

function isWarning(value: unknown): boolean {
  if (!isRecord(value) || typeof value.code !== "string" || !WARNING_CODES.has(value.code)) return false;
  if (typeof value.severity !== "string" || !WARNING_SEVERITIES.has(value.severity)) return false;
  if (!isNonemptyString(value.title) || !isNonemptyString(value.detail)) return false;
  if (value.componentId !== undefined && typeof value.componentId !== "string") return false;
  return value.estimatedWasteTokens === undefined || isNonnegativeInteger(value.estimatedWasteTokens);
}

function isExchange(value: unknown): boolean {
  return isRecord(value) &&
    (value.captureMode === "none" || value.captureMode === "redacted") &&
    typeof value.truncated === "boolean" &&
    Object.hasOwn(value, "request") &&
    Object.hasOwn(value, "response");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return isNonnegativeNumber(value) && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonnegativeInteger(value) && value > 0;
}

function isNullableNonnegativeNumber(value: unknown): boolean {
  return value === null || isNonnegativeNumber(value);
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return value === null || isNonnegativeInteger(value);
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs and some mounted filesystems do not expose POSIX modes.
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
