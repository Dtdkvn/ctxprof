export const SCHEMA_VERSION = 1 as const;

export type ComponentKind =
  | "system"
  | "developer"
  | "tools"
  | "message"
  | "tool_result"
  | "other";

export type WarningCode =
  | "unused-tool"
  | "large-tool-result"
  | "dominant-system-prompt"
  | "duplicate-context"
  | "context-pressure"
  | "unknown-pricing"
  | "large-tool-schema";

export interface ContextComponent {
  id: string;
  kind: ComponentKind;
  label: string;
  estimatedTokens: number;
  allocatedInputTokens: number;
  bytes: number;
  share: number;
  estimatedCostUsd: number | null;
  contentHash: string;
  preview: string | null;
}

export interface ProfileWarning {
  code: WarningCode;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  componentId?: string;
  estimatedWasteTokens?: number;
}

export interface PricingRecord {
  model: string;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  contextWindow: number | null;
  source: string;
  checkedAt: string;
}

export interface ProfileTotals {
  estimatedInputTokens: number;
  providerInputTokens: number | null;
  outputTokens: number;
  totalTokens: number;
  estimatedInputCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  estimatedTotalCostUsd: number | null;
  estimatedWasteTokens: number;
}

export interface StoredExchange {
  request: unknown | null;
  response: unknown | null;
  captureMode: "none" | "redacted";
  truncated: boolean;
}

export interface ProfileRun {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  capturedAt: string;
  durationMs: number | null;
  endpoint: string;
  status: number | null;
  model: string;
  label: string;
  promptVersion: string;
  source: "proxy" | "import" | "fixture";
  tokenizer: {
    method: "utf8-byte-estimate-v1";
    exact: false;
    note: string;
  };
  pricing: PricingRecord | null;
  components: ContextComponent[];
  totals: ProfileTotals;
  warnings: ProfileWarning[];
  exchange: StoredExchange;
}

export interface AnalyzeOptions {
  endpoint?: string;
  model?: string;
  label?: string;
  promptVersion?: string;
  source?: ProfileRun["source"];
  status?: number | null;
  durationMs?: number | null;
  captureMode?: "none" | "redacted";
  previewChars?: number;
  maxCaptureBytes?: number;
  capturedAt?: string;
  pricing?: PricingRecord[];
}

export interface BudgetMetrics {
  inputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  components: Record<ComponentKind, number>;
  warnings: number;
}

export interface BudgetBaseline {
  schemaVersion: 1;
  generatedAt: string;
  cases: Record<string, BudgetMetrics>;
}

export interface BudgetConfig {
  input?: string[];
  baseline?: string;
  limits?: {
    inputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    warnings?: number;
    components?: Partial<Record<ComponentKind, number>>;
  };
  regressions?: {
    inputTokensPercent?: number;
    totalTokensPercent?: number;
    estimatedCostPercent?: number;
    componentPercent?: number;
    warningsIncrease?: number;
  };
}

export interface BudgetViolation {
  caseName: string;
  metric: string;
  actual: number;
  allowed: number;
  message: string;
}

export interface BudgetResult {
  passed: boolean;
  cases: Record<string, BudgetMetrics>;
  violations: BudgetViolation[];
}

export interface VersionSummary {
  version: string;
  runCount: number;
  averageInputTokens: number;
  averageTotalTokens: number;
  averageCostUsd: number | null;
  averageWarnings: number;
  components: Record<ComponentKind, number>;
}

export interface VersionDiff {
  from: VersionSummary;
  to: VersionSummary;
  delta: {
    inputTokens: number;
    inputTokensPercent: number | null;
    totalTokens: number;
    costUsd: number | null;
    costPercent: number | null;
    components: Record<ComponentKind, number>;
  };
}
