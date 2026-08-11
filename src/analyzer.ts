import { createHash, randomUUID, type Hash } from "node:crypto";
import { MAX_PROFILE_COMPONENTS, MAX_PROFILE_RUN_BYTES, MAX_PROFILE_WARNINGS } from "./limits.js";
import { contentHash, redactText, redactValue } from "./redaction.js";
import { findPricing } from "./pricing.js";
import { estimateTokens, stableStringify } from "./tokenizer.js";
import {
  SCHEMA_VERSION,
  type AnalyzeOptions,
  type ComponentKind,
  type ContextComponent,
  type PricingRecord,
  type ProfileRun,
  type ProfileWarning,
} from "./types.js";

interface DraftComponent {
  kind: ComponentKind;
  label: string;
  previewSource: unknown;
  estimatedTokens: number;
  bytes: number;
  contentHash: string;
  aggregateCount?: number;
}

interface DraftInput {
  kind: ComponentKind;
  label: string;
  text: string;
  previewSource: unknown;
  overheadTokens?: number;
}

interface ComponentAccumulator {
  drafts: DraftComponent[];
  aggregates: Map<ComponentKind, ComponentAggregate>;
}

interface ComponentAggregate {
  count: number;
  estimatedTokens: number;
  bytes: number;
  hash: Hash;
}

interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  invalid: boolean;
}

const COMPONENT_COLORS: Record<ComponentKind, string> = {
  system: "system",
  developer: "developer",
  tools: "tools",
  message: "message",
  tool_result: "tool_result",
  other: "other",
};
const COMPONENT_KINDS: readonly ComponentKind[] = [
  "system",
  "developer",
  "tools",
  "message",
  "tool_result",
  "other",
];
const MAX_DETAILED_COMPONENTS = MAX_PROFILE_COMPONENTS - COMPONENT_KINDS.length;

export function analyzeExchange(
  request: unknown,
  response: unknown = null,
  options: AnalyzeOptions = {},
): ProfileRun {
  const requestRecord = isRecord(request) ? request : { input: request };
  const responseRecord = isRecord(response) ? response : null;
  const model = safeField(firstString(options.model, requestRecord.model, responseRecord?.model, "unknown"), 200);
  const endpoint = safeEndpoint(options.endpoint ?? inferEndpoint(requestRecord));
  const promptVersion = safeField(firstString(
    options.promptVersion,
    readMetadata(requestRecord, "prompt_version"),
    requestRecord.prompt_version,
    "unversioned",
  ), 160);
  const label = safeField(firstString(
    options.label,
    readMetadata(requestRecord, "label"),
    requestRecord.label,
    promptVersion,
  ), 200);

  const extracted = extractComponents(requestRecord);
  const drafts = extracted.drafts;
  const providerUsage = extractUsage(responseRecord);
  const pricing = findPricing(model, options.pricing ?? []);
  const rawEstimates = drafts.map((draft) => draft.estimatedTokens);
  const estimatedInputTokens = rawEstimates.reduce((sum, tokens) => sum + tokens, 0);
  const allocated = allocateTokens(rawEstimates, providerUsage.inputTokens ?? estimatedInputTokens);
  const captureMode = options.captureMode ?? "redacted";
  // `none` is the CLI's strongest privacy mode. Component previews contain
  // prompt text too, so omitting only the exchange would be misleading.
  const previewChars = captureMode === "none" ? 0 : Math.max(0, options.previewChars ?? 180);

  const detailedComponents: ContextComponent[] = drafts.map((draft, index) => {
    const estimatedTokens = rawEstimates[index] ?? 0;
    const allocatedInputTokens = allocated[index] ?? estimatedTokens;
    // Redact the structured source before serializing it. Redacting `draft.text`
    // alone loses sensitive key names such as `api_key` embedded in JSON.
    const redacted = draft.aggregateCount
      ? { value: null }
      : redactValue(draft.previewSource, { maxStringChars: previewChars });
    const previewValue = typeof redacted.value === "string" ? redacted.value : stableStringify(redacted.value);
    const safeLabel = safeField(draft.label, 240);
    return {
      id: `${COMPONENT_COLORS[draft.kind]}-${index + 1}-${draft.contentHash}`,
      kind: draft.kind,
      label: safeLabel,
      estimatedTokens,
      allocatedInputTokens,
      bytes: draft.bytes,
      share: estimatedInputTokens === 0 ? 0 : estimatedTokens / estimatedInputTokens,
      estimatedCostUsd: pricing
        ? roundUsd((allocatedInputTokens / 1_000_000) * pricing.inputPerMillionUsd)
        : null,
      contentHash: draft.contentHash,
      preview: previewChars === 0 || draft.aggregateCount ? null : previewValue.slice(0, previewChars),
    };
  });

  const outputTokens = providerUsage.outputTokens ?? estimateResponseTokens(responseRecord);
  const billedInput = providerUsage.inputTokens;
  const pricedInput = billedInput ?? estimatedInputTokens;
  const inputCost = pricing
    ? roundUsd((pricedInput / 1_000_000) * pricing.inputPerMillionUsd)
    : null;
  const outputCost = pricing
    ? roundUsd((outputTokens / 1_000_000) * pricing.outputPerMillionUsd)
    : null;
  const rawWarnings = buildWarnings(
    requestRecord,
    responseRecord,
    detailedComponents,
    pricing,
    providerUsage.invalid,
  );
  const estimatedWasteTokens = estimateUniqueWaste(rawWarnings);
  const truncationReasons: string[] = [];
  const components = detailedComponents;
  if (extracted.aggregateCount > 0) {
    truncationReasons.push(
      `${extracted.aggregateCount.toLocaleString("en-US")} components were combined into per-kind aggregates while token, byte, cost, and content-hash evidence was retained.`,
    );
  }
  if (rawWarnings.length > MAX_PROFILE_WARNINGS) {
    truncationReasons.push(
      `${rawWarnings.length - (MAX_PROFILE_WARNINGS - 1)} additional warning signals were omitted.`,
    );
  }
  const warnings = boundWarnings(rawWarnings, truncationReasons);
  const captured = captureExchange(
    request,
    response,
    captureMode,
    options.maxCaptureBytes ?? 256 * 1024,
  );

  const run: ProfileRun = {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    durationMs: options.durationMs ?? null,
    endpoint,
    status: options.status ?? null,
    model,
    label,
    promptVersion,
    source: options.source ?? "import",
    tokenizer: {
      method: "utf8-byte-estimate-v1",
      exact: false,
      note:
        "Component counts are deterministic estimates, not provider tokenizer output. Provider usage totals are shown separately when available.",
    },
    pricing,
    components,
    totals: {
      estimatedInputTokens,
      providerInputTokens: billedInput,
      outputTokens,
      totalTokens: (billedInput ?? estimatedInputTokens) + outputTokens,
      estimatedInputCostUsd: inputCost,
      estimatedOutputCostUsd: outputCost,
      estimatedTotalCostUsd:
        inputCost === null || outputCost === null ? null : roundUsd(inputCost + outputCost),
      estimatedWasteTokens,
    },
    warnings,
    exchange: captured,
  };
  return enforceProfileRunSize(run, request, truncationReasons);
}

function boundWarnings(
  warnings: readonly ProfileWarning[],
  truncationReasons: readonly string[],
): ProfileWarning[] {
  const ordinary = warnings.filter((warning) => warning.code !== "analysis-truncated");
  if (truncationReasons.length === 0 && ordinary.length <= MAX_PROFILE_WARNINGS) return [...ordinary];
  return [
    ...ordinary.slice(0, MAX_PROFILE_WARNINGS - 1),
    {
      code: "analysis-truncated",
      severity: "warning",
      title: "Analysis details were bounded",
      detail: truncationReasons.join(" "),
    },
  ];
}

function enforceProfileRunSize(
  run: ProfileRun,
  request: unknown,
  initialReasons: readonly string[],
): ProfileRun {
  if (profileRunBytes(run) <= MAX_PROFILE_RUN_BYTES) return run;
  const reasons = [...initialReasons, "The stored exchange body was omitted to keep this run within its storage limit."];
  run.exchange = {
    request: {
      notice: "Capture omitted because the normalized run exceeded its storage limit.",
      contentHash: contentHash(stableStringify(request)),
    },
    response: null,
    captureMode: "redacted",
    truncated: true,
  };
  run.warnings = boundWarnings(run.warnings, reasons);
  if (profileRunBytes(run) <= MAX_PROFILE_RUN_BYTES) return run;

  reasons.push("Component previews were omitted to keep the normalized run bounded.");
  run.components = run.components.map((component) => ({ ...component, preview: null }));
  run.warnings = boundWarnings(run.warnings, reasons);
  const bytes = profileRunBytes(run);
  if (bytes > MAX_PROFILE_RUN_BYTES) {
    throw new Error(
      `Normalized ProfileRun is ${bytes} bytes after safe truncation; the limit is ${MAX_PROFILE_RUN_BYTES} bytes.`,
    );
  }
  return run;
}

function profileRunBytes(run: ProfileRun): number {
  return Buffer.byteLength(JSON.stringify(run), "utf8");
}

function extractComponents(request: Record<string, unknown>): {
  drafts: DraftComponent[];
  aggregateCount: number;
} {
  const accumulator: ComponentAccumulator = {
    drafts: [],
    aggregates: new Map(),
  };
  if (typeof request.instructions === "string" && request.instructions.length > 0) {
    addDraft(accumulator, {
      kind: "system",
      label: "Responses instructions",
      text: request.instructions,
      previewSource: request.instructions,
      overheadTokens: 3,
    });
  }

  const messages = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : typeof request.input === "string"
        ? [{ role: "user", content: request.input }]
        : [];
  for (const [index, rawMessage] of messages.entries()) {
    if (!isRecord(rawMessage)) {
      addDraft(accumulator, {
        kind: "message",
        label: `Input ${index + 1}`,
        text: stableStringify(rawMessage),
        previewSource: rawMessage,
        overheadTokens: 4,
      });
      continue;
    }
    const role = typeof rawMessage.role === "string" ? rawMessage.role : "input";
    const type = typeof rawMessage.type === "string" ? rawMessage.type : "";
    const kind = classifyMessage(role, type);
    const text = extractMessageText(rawMessage);
    addDraft(accumulator, {
      kind,
      label: messageLabel(rawMessage, role, type, index),
      text,
      previewSource: messagePreviewSource(rawMessage),
      overheadTokens: 4,
    });
  }

  if (Array.isArray(request.tools)) {
    for (const [index, tool] of request.tools.entries()) {
      const name = safeField(toolName(tool) ?? `tool_${index + 1}`, 160);
      addDraft(accumulator, {
        kind: "tools",
        label: `Tool · ${name}`,
        text: stableStringify(tool),
        previewSource: tool,
        overheadTokens: 4,
      });
    }
  }

  const responseFormat = request.response_format ?? request.text;
  if (responseFormat !== undefined) {
    addDraft(accumulator, {
      kind: "other",
      label: "Response format",
      text: stableStringify(responseFormat),
      previewSource: responseFormat,
      overheadTokens: 2,
    });
  }
  if (accumulator.drafts.length === 0 && accumulator.aggregates.size === 0) {
    addDraft(accumulator, {
      kind: "other",
      label: "Serialized request",
      text: stableStringify(request),
      previewSource: request,
      overheadTokens: 2,
    });
  }
  let aggregateCount = 0;
  for (const kind of COMPONENT_KINDS) {
    const aggregate = accumulator.aggregates.get(kind);
    if (!aggregate) continue;
    aggregateCount += aggregate.count;
    accumulator.drafts.push({
      kind,
      label: `${aggregate.count.toLocaleString("en-US")} additional ${componentKindName(kind)} components (aggregated)`,
      previewSource: null,
      estimatedTokens: aggregate.estimatedTokens,
      bytes: aggregate.bytes,
      contentHash: aggregate.hash.digest("hex").slice(0, 16),
      aggregateCount: aggregate.count,
    });
  }
  return { drafts: accumulator.drafts, aggregateCount };
}

function addDraft(accumulator: ComponentAccumulator, draft: DraftInput): void {
  const estimatedTokens = Math.max(1, estimateTokens(draft.text) + (draft.overheadTokens ?? 0));
  const bytes = Buffer.byteLength(draft.text, "utf8");
  if (accumulator.drafts.length < MAX_DETAILED_COMPONENTS) {
    accumulator.drafts.push({
      kind: draft.kind,
      label: draft.label,
      previewSource: draft.previewSource,
      estimatedTokens,
      bytes,
      contentHash: contentHash(draft.text),
    });
    return;
  }
  let aggregate = accumulator.aggregates.get(draft.kind);
  if (!aggregate) {
    aggregate = { count: 0, estimatedTokens: 0, bytes: 0, hash: createHash("sha256") };
    accumulator.aggregates.set(draft.kind, aggregate);
  }
  aggregate.count += 1;
  aggregate.estimatedTokens += estimatedTokens;
  aggregate.bytes += bytes;
  aggregate.hash
    .update(draft.kind)
    .update("\0")
    .update(String(bytes))
    .update("\0")
    .update(draft.text)
    .update("\0");
}

function componentKindName(kind: ComponentKind): string {
  if (kind === "tool_result") return "tool-result";
  if (kind === "tools") return "tool-schema";
  return kind;
}

function classifyMessage(role: string, type: string): ComponentKind {
  if (role === "system") return "system";
  if (role === "developer") return "developer";
  if (role === "tool" || type === "function_call_output" || type === "tool_result") {
    return "tool_result";
  }
  return "message";
}

function messageLabel(
  message: Record<string, unknown>,
  role: string,
  type: string,
  index: number,
): string {
  if (role === "tool" || type === "function_call_output" || type === "tool_result") {
    return `Tool result · ${firstString(message.name, message.call_id, `#${index + 1}`)}`;
  }
  const name = typeof message.name === "string" ? ` · ${message.name}` : "";
  return `${titleCase(role || type || "input")}${name} · #${index + 1}`;
}

function extractMessageText(message: Record<string, unknown>): string {
  const content = message.content ?? message.output ?? message.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return stableStringify(part);
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        if (typeof part.output_text === "string") return part.output_text;
        return stableStringify(part);
      })
      .join("\n");
  }
  if (content !== undefined) return stableStringify(content);
  return stableStringify(message);
}

function messagePreviewSource(message: Record<string, unknown>): unknown {
  const content = message.content ?? message.output ?? message.text;
  return content === undefined ? message : content;
}

function buildWarnings(
  request: Record<string, unknown>,
  response: Record<string, unknown> | null,
  components: ContextComponent[],
  pricing: PricingRecord | null,
  invalidProviderUsage: boolean,
): ProfileWarning[] {
  const warnings: ProfileWarning[] = [];
  if (invalidProviderUsage) {
    warnings.push({
      code: "invalid-provider-usage",
      severity: "warning",
      title: "Provider usage is invalid",
      detail: "One or more provider token counts were negative, fractional, non-finite, or outside JavaScript's safe-integer range. Ctxprof ignored those fields and used deterministic estimates instead.",
    });
  }
  const allocatedInput = components.reduce((sum, component) => sum + component.allocatedInputTokens, 0);
  const usedTools = collectUsedToolNames(request, response);

  for (const component of components) {
    if (component.kind === "tools") {
      const name = component.label.replace(/^Tool · /, "");
      if (!usedTools.has(name)) {
        warnings.push({
          code: "unused-tool",
          severity: "info",
          title: `Tool “${name}” was not used`,
          detail:
            "This single exchange did not call the tool. Consider loading tools on demand, but validate across representative traffic first.",
          componentId: component.id,
          estimatedWasteTokens: component.allocatedInputTokens,
        });
      }
      if (component.allocatedInputTokens >= 1_000) {
        warnings.push({
          code: "large-tool-schema",
          severity: "warning",
          title: `Large schema for “${name}”`,
          detail: `${component.allocatedInputTokens.toLocaleString()} allocated tokens are spent describing this tool on every request.`,
          componentId: component.id,
        });
      }
    }
    if (
      component.kind === "tool_result" &&
      (component.allocatedInputTokens >= 2_000 || component.share >= 0.25)
    ) {
      warnings.push({
        code: "large-tool-result",
        severity: component.share >= 0.5 ? "critical" : "warning",
        title: "Tool result dominates the context",
        detail: `${Math.round(component.share * 100)}% of estimated input is one tool result. Summarize, paginate, or select fields before reinserting it.`,
        componentId: component.id,
        estimatedWasteTokens: Math.max(0, component.allocatedInputTokens - 1_000),
      });
    }
    if (component.kind === "system" && component.share >= 0.35 && component.allocatedInputTokens >= 500) {
      warnings.push({
        code: "dominant-system-prompt",
        severity: "warning",
        title: "System prompt dominates the context",
        detail: `${Math.round(component.share * 100)}% of estimated input belongs to this system prompt. Split policy from task-specific guidance and test shorter variants.`,
        componentId: component.id,
      });
    }
  }

  const seen = new Map<string, ContextComponent>();
  for (const component of components) {
    const prior = seen.get(component.contentHash);
    if (prior && component.estimatedTokens >= 50) {
      warnings.push({
        code: "duplicate-context",
        severity: "warning",
        title: "Duplicate context detected",
        detail: `“${component.label}” repeats the content of “${prior.label}”.`,
        componentId: component.id,
        estimatedWasteTokens: component.allocatedInputTokens,
      });
    } else {
      seen.set(component.contentHash, component);
    }
  }

  if (!pricing) {
    warnings.push({
      code: "unknown-pricing",
      severity: "info",
      title: "Price is unknown for this model",
      detail: "Add an exact model entry to a pricing catalog instead of relying on a guessed alias.",
    });
  } else if (pricing.contextWindow && allocatedInput / pricing.contextWindow >= 0.8) {
    warnings.push({
      code: "context-pressure",
      severity: allocatedInput > pricing.contextWindow ? "critical" : "warning",
      title: "Context window is under pressure",
      detail: `${Math.round((allocatedInput / pricing.contextWindow) * 100)}% of the cataloged context window is occupied by input.`,
    });
  }
  return warnings;
}

function collectUsedToolNames(
  request: Record<string, unknown>,
  response: Record<string, unknown> | null,
): Set<string> {
  const names = new Set<string>();
  walk([request.messages, request.input, response], (record) => {
    if (record.role === "tool" && typeof record.name === "string") {
      names.add(safeField(record.name, 160));
    }
    if (
      (record.type === "function_call" || record.type === "tool_call") &&
      typeof record.name === "string"
    ) {
      names.add(safeField(record.name, 160));
    }
    if (isRecord(record.function) && typeof record.function.name === "string") {
      names.add(safeField(record.function.name, 160));
    }
    if (Array.isArray(record.tool_calls)) {
      for (const toolCall of record.tool_calls) {
        if (isRecord(toolCall) && isRecord(toolCall.function) && typeof toolCall.function.name === "string") {
          names.add(safeField(toolCall.function.name, 160));
        }
      }
    }
  });
  return names;
}

function walk(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visitor);
  } else if (isRecord(value)) {
    visitor(value);
    for (const child of Object.values(value)) walk(child, visitor);
  }
}

function toolName(tool: unknown): string | null {
  if (!isRecord(tool)) return null;
  if (typeof tool.name === "string") return tool.name;
  if (isRecord(tool.function) && typeof tool.function.name === "string") return tool.function.name;
  if (typeof tool.type === "string") return tool.type;
  return null;
}

function extractUsage(response: Record<string, unknown> | null): ProviderUsage {
  const usage = response && isRecord(response.usage) ? response.usage : null;
  if (!usage) return { inputTokens: null, outputTokens: null, invalid: false };
  const input = firstSafeTokenCount(usage.prompt_tokens, usage.input_tokens);
  const output = firstSafeTokenCount(usage.completion_tokens, usage.output_tokens);
  return {
    inputTokens: input.value,
    outputTokens: output.value,
    invalid: input.invalid || output.invalid,
  };
}

function estimateResponseTokens(response: Record<string, unknown> | null): number {
  if (!response) return 0;
  const text: string[] = [];
  walk(response, (record) => {
    if (typeof record.content === "string") text.push(record.content);
    if (typeof record.text === "string") text.push(record.text);
    if (typeof record.output_text === "string") text.push(record.output_text);
  });
  return estimateTokens(text.join("\n"));
}

function captureExchange(
  request: unknown,
  response: unknown,
  mode: "none" | "redacted",
  maxBytes: number,
): ProfileRun["exchange"] {
  if (mode === "none") {
    return { request: null, response: null, captureMode: "none", truncated: false };
  }
  const requestResult = redactValue(request);
  const responseResult = redactValue(response);
  const combined = { request: requestResult.value, response: responseResult.value };
  const serialized = stableStringify(combined);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return {
      request: {
        notice: "Capture exceeded the configured byte limit and was omitted.",
        contentHash: contentHash(stableStringify(request)),
      },
      response: null,
      captureMode: "redacted",
      truncated: true,
    };
  }
  return {
    request: requestResult.value,
    response: responseResult.value,
    captureMode: "redacted",
    truncated: requestResult.truncated || responseResult.truncated,
  };
}

function allocateTokens(estimates: number[], target: number): number[] {
  const total = estimates.reduce((sum, value) => sum + value, 0);
  if (estimates.length === 0 || total === 0) return [];
  const integerTarget = Math.max(0, Math.round(target));
  const exact = estimates.map((value) => (value / total) * integerTarget);
  const result = exact.map(Math.floor);
  let remaining = integerTarget - result.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index += 1) {
    const targetIndex = byRemainder[index]?.index;
    if (targetIndex !== undefined) result[targetIndex] = (result[targetIndex] ?? 0) + 1;
  }
  return result;
}

function inferEndpoint(request: Record<string, unknown>): string {
  return request.messages ? "/v1/chat/completions" : "/v1/responses";
}

function readMetadata(request: Record<string, unknown>, key: string): unknown {
  if (!isRecord(request.metadata)) return undefined;
  if (isRecord(request.metadata.ctxprof) && request.metadata.ctxprof[key] !== undefined) {
    return request.metadata.ctxprof[key];
  }
  return request.metadata[key];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "unknown";
}

function firstSafeTokenCount(...values: unknown[]): { value: number | null; invalid: boolean } {
  let invalid = false;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return { value, invalid };
    }
    invalid = true;
  }
  return { value: null, invalid };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function safeField(value: string, maxLength: number): string {
  return redactText(value).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLength) || "unknown";
}

function safeEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    return safeField(parsed.pathname || "/", 500);
  } catch {
    return safeField(value.split(/[?#]/, 1)[0] ?? value, 500);
  }
}

function estimateUniqueWaste(warnings: readonly ProfileWarning[]): number {
  const perComponent = new Map<string, number>();
  let unscoped = 0;
  for (const warning of warnings) {
    const waste = warning.estimatedWasteTokens ?? 0;
    if (!warning.componentId) unscoped += waste;
    else perComponent.set(warning.componentId, Math.max(perComponent.get(warning.componentId) ?? 0, waste));
  }
  return [...perComponent.values()].reduce((sum, value) => sum + value, unscoped);
}
