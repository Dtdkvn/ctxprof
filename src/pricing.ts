import { readFile } from "node:fs/promises";
import type { PricingRecord } from "./types.js";

const OPENAI_MODELS_URL = "https://developers.openai.com/api/docs/models";

// Standard text-token prices. Cached input, batch, priority processing, tools,
// audio, images, data residency, and long-context multipliers are deliberately
// excluded: applying them without full billing metadata would imply false accuracy.
export const BUILTIN_PRICING: readonly PricingRecord[] = [
  {
    model: "gpt-5.6-sol",
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
    contextWindow: 1_050_000,
    source: OPENAI_MODELS_URL,
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5.6",
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
    contextWindow: 1_050_000,
    source: OPENAI_MODELS_URL,
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5.6-terra",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 15,
    contextWindow: 1_050_000,
    source: OPENAI_MODELS_URL,
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5.6-luna",
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 6,
    contextWindow: 1_050_000,
    source: OPENAI_MODELS_URL,
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5.5",
    inputPerMillionUsd: 5,
    outputPerMillionUsd: 30,
    contextWindow: 1_050_000,
    source: "https://developers.openai.com/api/docs/models/gpt-5.5",
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5.4",
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 15,
    contextWindow: 1_050_000,
    source: "https://developers.openai.com/api/docs/models/gpt-5.4",
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-5",
    inputPerMillionUsd: 1.25,
    outputPerMillionUsd: 10,
    contextWindow: 400_000,
    source: "https://developers.openai.com/api/docs/models/gpt-5",
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-4.1",
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 8,
    contextWindow: 1_047_576,
    source: "https://developers.openai.com/api/docs/models/gpt-4.1",
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-4.1-mini",
    inputPerMillionUsd: 0.4,
    outputPerMillionUsd: 1.6,
    contextWindow: 1_047_576,
    source: "https://openai.com/index/gpt-4-1/",
    checkedAt: "2026-08-11",
  },
  {
    model: "gpt-4.1-nano",
    inputPerMillionUsd: 0.1,
    outputPerMillionUsd: 0.4,
    contextWindow: 1_047_576,
    source: "https://openai.com/index/gpt-4-1/",
    checkedAt: "2026-08-11",
  },
];

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

export function findPricing(
  model: string,
  additional: readonly PricingRecord[] = [],
): PricingRecord | null {
  const normalized = normalizeModel(model);
  const records = [...additional, ...BUILTIN_PRICING];
  const exact = records.find((record) => normalizeModel(record.model) === normalized);
  if (exact) return { ...exact };

  // Snapshot model IDs conventionally append a date. Require a separator so a
  // similarly named model cannot accidentally inherit a price.
  const compatible = records
    .filter((record) => {
      const base = normalizeModel(record.model);
      return normalized.startsWith(`${base}-20`);
    })
    .sort((a, b) => b.model.length - a.model.length)[0];
  return compatible ? { ...compatible, model } : null;
}

export async function loadPricingFile(filePath: string | undefined): Promise<PricingRecord[]> {
  if (!filePath) return [];
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
  if (!Array.isArray(value)) {
    throw new Error("Pricing catalog must be a JSON array.");
  }
  return value.map((entry, index) => validatePricing(entry, index));
}

function validatePricing(value: unknown, index: number): PricingRecord {
  if (!value || typeof value !== "object") {
    throw new Error(`Pricing record ${index} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  const model = candidate.model;
  const input = candidate.inputPerMillionUsd;
  const output = candidate.outputPerMillionUsd;
  if (typeof model !== "string" || model.length === 0) {
    throw new Error(`Pricing record ${index} has no model.`);
  }
  if (typeof input !== "number" || input < 0 || !Number.isFinite(input)) {
    throw new Error(`Pricing record ${index} has an invalid input price.`);
  }
  if (typeof output !== "number" || output < 0 || !Number.isFinite(output)) {
    throw new Error(`Pricing record ${index} has an invalid output price.`);
  }
  const contextWindow = candidate.contextWindow;
  if (contextWindow !== null && (typeof contextWindow !== "number" || contextWindow <= 0)) {
    throw new Error(`Pricing record ${index} has an invalid context window.`);
  }
  return {
    model,
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
    contextWindow: contextWindow as number | null,
    source: typeof candidate.source === "string" ? candidate.source : "user catalog",
    checkedAt: typeof candidate.checkedAt === "string" ? candidate.checkedAt : "user supplied",
  };
}
