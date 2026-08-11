const CJK_OR_EMOJI = /[\u3400-\u9fff\uf900-\ufaff\u{1f000}-\u{1faff}]/gu;

/**
 * A deterministic, dependency-free estimate intended for relative profiling.
 * It is not a provider tokenizer. ASCII-ish text is estimated from UTF-8 bytes
 * at four bytes/token; CJK and emoji code points receive one token each.
 */
export function estimateTokens(value: string): number {
  if (value.length === 0) return 0;
  let special = 0;
  const remainder = value.replace(CJK_OR_EMOJI, () => {
    special += 1;
    return "";
  });
  return Math.max(1, special + Math.ceil(Buffer.byteLength(remainder, "utf8") / 4));
}

export function estimateSerializedTokens(value: unknown): number {
  return estimateTokens(typeof value === "string" ? value : stableStringify(value));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}
