import { createHash } from "node:crypto";

const DEFAULT_MAX_STRING_CHARS = 16_384;
const MAX_INLINE_CREDENTIAL_CHARS = DEFAULT_MAX_STRING_CHARS * 2;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack tokens use stable, high-signal prefixes. The surrounding guards keep
  // documentation fragments and substrings inside larger identifiers intact.
  /(?<![A-Za-z0-9_-])(?:xox[a-z]|xapp)-(?:[A-Za-z0-9]{1,128}-){1,4}[A-Za-z0-9]{8,256}(?![A-Za-z0-9_-])/g,
  // Google API keys are `AIza` followed by exactly 35 URL-safe characters.
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
];
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "authorization",
  "client_secret",
  "code",
  "password",
  "refresh_token",
  "secret",
  "session_token",
  "sig",
  "signature",
  "token",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);
const EXACT_SENSITIVE_KEYS = new Set([
  "apikey",
  "apisecret",
  "authorization",
  "auth",
  "bearer",
  "clientsecret",
  "consumersecret",
  "cookie",
  "jwt",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "secretaccesskey",
  "secretkey",
  "session",
  "token",
]);
const SENSITIVE_KEY_SUFFIXES = new Set([
  "accesstoken",
  "apitoken",
  "authtoken",
  "bearertoken",
  "idtoken",
  "refreshtoken",
  "sessionid",
  "sessiontoken",
  "signingsecret",
  "webhooksecret",
]);
const SAFE_KEY_QUALIFIERS = new Set([
  "banner",
  "count",
  "duration",
  "hint",
  "method",
  "mode",
  "policy",
  "recipe",
]);

export interface RedactionOptions {
  maxStringChars?: number;
  maxDepth?: number;
  redactEmails?: boolean;
}

interface RedactionState {
  truncated: boolean;
}

export function redactValue(
  value: unknown,
  options: RedactionOptions = {},
): { value: unknown; truncated: boolean } {
  const state: RedactionState = { truncated: false };
  const redacted = visit(value, options, state, 0, "");
  return { value: redacted, truncated: state.truncated };
}

function visit(
  value: unknown,
  options: RedactionOptions,
  state: RedactionState,
  depth: number,
  key: string,
): unknown {
  const maxDepth = options.maxDepth ?? 30;
  if (depth > maxDepth) {
    state.truncated = true;
    return "[TRUNCATED: depth limit]";
  }
  if (key && isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value, options, state);
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, 2_000);
    if (limit !== value.length) state.truncated = true;
    return value.slice(0, limit).map((entry) => visit(entry, options, state, depth + 1, ""));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      // A credential can appear as the property name itself, for example when a
      // payload is keyed by API key. Names are scanned with the same patterns as
      // values so a secret cannot reach the store by sitting in key position.
      result[redactString(childKey, options, state)] = visit(child, options, state, depth + 1, childKey);
    }
    return result;
  }
  return value;
}

function redactString(value: string, options: RedactionOptions, state: RedactionState): string {
  const max = Math.max(0, options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS);
  // Only persisted output needs scanning. The look-ahead catches a credential
  // that starts immediately before the truncation boundary while bounding work
  // for arbitrarily large library strings.
  const scanLength = Math.min(value.length, max + MAX_INLINE_CREDENTIAL_CHARS);
  let result = value.slice(0, scanLength);
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  result = redactPartialPrivateKey(result);
  result = redactAuthorizationCredentials(result);
  result = redactJwtCredentials(result);
  result = redactPartialJwt(result);
  result = redactCredentialUrls(result);
  if (options.redactEmails) {
    result = result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  }
  if (value.length > max) {
    state.truncated = true;
    result = `${result.slice(0, max)}…[TRUNCATED ${value.length - max} chars]`;
  }
  return result;
}

function redactAuthorizationCredentials(value: string): string {
  return replaceCredentialCandidates(value, /\b(Bearer|Basic)[ \t]+/gi, (scheme, candidate) => {
    if (scheme.toLowerCase() === "basic") return isBasicCredential(candidate);
    return isBearerCredential(candidate);
  });
}

function redactPartialPrivateKey(value: string): string {
  const match = PRIVATE_KEY_BEGIN.exec(value);
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  if (!match || match.index === undefined) return value;
  // A complete key was handled above. A BEGIN marker without an END marker in
  // the bounded scan crosses the truncation boundary, so fail closed.
  return `${value.slice(0, match.index)}[REDACTED]`;
}

function replaceCredentialCandidates(
  value: string,
  prefix: RegExp,
  isCredential: (scheme: string, candidate: string) => boolean,
): string {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(prefix)) {
    const start = match.index;
    if (start === undefined || start < cursor) continue;
    const scheme = match[1]!;
    const candidateStart = start + match[0].length;
    let end = candidateStart;
    while (end < value.length && isAuthorizationCharacter(value[end]!, scheme)) end += 1;
    const candidate = value.slice(candidateStart, end);
    result += value.slice(cursor, start);
    if (candidate.length > MAX_INLINE_CREDENTIAL_CHARS || isCredential(scheme, candidate)) {
      result += "[REDACTED]";
    } else {
      result += value.slice(start, end);
    }
    cursor = end;
  }
  return result + value.slice(cursor);
}

function isAuthorizationCharacter(character: string, scheme: string): boolean {
  return scheme.toLowerCase() === "basic"
    ? /[A-Za-z0-9+/=]/.test(character)
    : /[A-Za-z0-9._~+/=-]/.test(character);
}

function isBasicCredential(encoded: string): boolean {
  if (encoded.length < 2 || encoded.length > MAX_INLINE_CREDENTIAL_CHARS) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const normalized = encoded.replace(/=+$/, "");
  if (normalized.length % 4 === 1) return false;
  const decoded = Buffer.from(encoded, "base64");
  return decoded.includes(0x3a) && decoded.toString("base64").replace(/=+$/, "") === normalized;
}

function isBearerCredential(candidate: string): boolean {
  if (candidate.length < 12 || candidate.length > MAX_INLINE_CREDENTIAL_CHARS) return false;
  if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(candidate)) return false;
  // A credential following an authorization scheme is high-confidence once it
  // is long enough; only short documentation labels remain untouched.
  return candidate.length >= 20;
}

function redactJwtCredentials(value: string): string {
  return value.replace(
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,})(?![A-Za-z0-9_-])/g,
    (candidate) => candidate.length > MAX_INLINE_CREDENTIAL_CHARS || isJwtCredential(candidate)
      ? "[REDACTED]"
      : candidate,
  );
}

function isJwtCredential(candidate: string): boolean {
  if (candidate.length > MAX_INLINE_CREDENTIAL_CHARS) return false;
  const segments = candidate.split(".");
  if (segments.length !== 3 || segments[2]!.length < 6) return false;
  return isJsonObjectSegment(segments[0]!) && isJsonObjectSegment(segments[1]!);
}

function redactPartialJwt(value: string): string {
  const partial = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{2,16384})\.([A-Za-z0-9_-]{2,})$/.exec(value);
  if (!partial || partial.index === undefined || !isJsonObjectSegment(partial[1]!)) return value;
  return `${value.slice(0, partial.index)}[REDACTED]`;
}

function isJsonObjectSegment(segment: string): boolean {
  if (!BASE64URL_SEGMENT.test(segment) || segment.length % 4 === 1) return false;
  try {
    const decoded = Buffer.from(segment, "base64url");
    if (decoded.toString("base64url") !== segment.replace(/=+$/, "")) return false;
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function redactCredentialUrls(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"'`]+/gi, (raw) => redactCredentialUrl(raw));
}

function redactCredentialUrl(raw: string): string {
  const trailing = /[),.;!?]+$/.exec(raw)?.[0] ?? "";
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return raw;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "REDACTED";
    url.password = "";
    changed = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, "REDACTED");
      changed = true;
    }
  }
  return changed ? `${url.toString()}${trailing}` : raw;
}

function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  for (const [index, segment] of segments.entries()) {
    if (SENSITIVE_KEY_SUFFIXES.has(segment)) return true;
    if (EXACT_SENSITIVE_KEYS.has(segment)) {
      if (segments.slice(index + 1).some((next) => SAFE_KEY_QUALIFIERS.has(next))) continue;
      return true;
    }
  }
  for (let index = 0; index < segments.length - 1; index += 1) {
    const pair = `${segments[index]}${segments[index + 1]}`;
    if (EXACT_SENSITIVE_KEYS.has(pair) || SENSITIVE_KEY_SUFFIXES.has(pair)) {
      if (segments.slice(index + 2).some((next) => SAFE_KEY_QUALIFIERS.has(next))) continue;
      return true;
    }
  }
  return false;
}

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
}

export function redactText(value: string): string {
  return redactString(value, {}, { truncated: false });
}

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message).replace(/[\r\n]+/g, " ").slice(0, 500);
}
