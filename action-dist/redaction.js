import { createHash } from "node:crypto";
const DEFAULT_MAX_STRING_CHARS = 16_384;
const MAX_INLINE_CREDENTIAL_CHARS = DEFAULT_MAX_STRING_CHARS * 2;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SECRET_PATTERNS = [
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
const URL_ONLY_SENSITIVE_KEYS = new Set([
    "code",
    "googleaccessid",
    "sig",
    "signature",
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
    "accesskeyid",
    "accesstoken",
    "apitoken",
    "authtoken",
    "bearertoken",
    "idtoken",
    "awsaccesskeyid",
    "refreshtoken",
    "sessionid",
    "sessiontoken",
    "signingsecret",
    "xamzcredential",
    "xamzsignature",
    "xgoogcredential",
    "xgoogsignature",
    "webhooksecret",
]);
const SAFE_KEY_QUALIFIERS = new Set([
    "algorithm",
    "banner",
    "challenge",
    "count",
    "duration",
    "hint",
    "method",
    "mode",
    "policy",
    "recipe",
    "type",
    "version",
]);
export function redactValue(value, options = {}) {
    const state = { truncated: false };
    const redacted = visit(value, options, state, 0, "");
    return { value: redacted, truncated: state.truncated };
}
function visit(value, options, state, depth, key) {
    const maxDepth = options.maxDepth ?? 30;
    if (depth > maxDepth) {
        state.truncated = true;
        return "[TRUNCATED: depth limit]";
    }
    if (key && isSensitiveKey(key))
        return "[REDACTED]";
    if (typeof value === "string")
        return redactString(value, options, state);
    if (Array.isArray(value)) {
        const limit = Math.min(value.length, 2_000);
        if (limit !== value.length)
            state.truncated = true;
        return value.slice(0, limit).map((entry) => visit(entry, options, state, depth + 1, ""));
    }
    if (value && typeof value === "object") {
        const result = {};
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
function redactString(value, options, state) {
    const max = Math.max(0, options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS);
    // Only persisted output needs scanning. The look-ahead catches a credential
    // that starts immediately before the truncation boundary while bounding work
    // for arbitrarily large library strings.
    const scanLength = Math.min(value.length, max + MAX_INLINE_CREDENTIAL_CHARS);
    const scanCrossesInput = scanLength < value.length;
    let result = value.slice(0, scanLength);
    for (const pattern of SECRET_PATTERNS)
        result = result.replace(pattern, "[REDACTED]");
    result = redactPartialPrivateKey(result);
    result = redactAuthorizationCredentials(result, scanCrossesInput);
    result = redactJwtCredentials(result);
    result = redactPartialJwt(result, scanCrossesInput);
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
function redactAuthorizationCredentials(value, scanCrossesInput) {
    return replaceCredentialCandidates(value, /\b(Bearer|Basic)[ \t]+/gi, (scheme, candidate, context) => {
        if (scheme.toLowerCase() === "basic")
            return isBasicCredential(candidate);
        return isBearerCredential(candidate, context);
    }, scanCrossesInput);
}
function redactPartialPrivateKey(value) {
    const match = PRIVATE_KEY_BEGIN.exec(value);
    PRIVATE_KEY_BEGIN.lastIndex = 0;
    if (!match || match.index === undefined)
        return value;
    // A complete key was handled above. A BEGIN marker without an END marker in
    // the bounded scan crosses the truncation boundary, so fail closed.
    return `${value.slice(0, match.index)}[REDACTED]`;
}
function replaceCredentialCandidates(value, prefix, isCredential, scanCrossesInput) {
    let result = "";
    let cursor = 0;
    for (const match of value.matchAll(prefix)) {
        const start = match.index;
        if (start === undefined || start < cursor)
            continue;
        const scheme = match[1];
        const candidateStart = start + match[0].length;
        let end = candidateStart;
        while (end < value.length && isAuthorizationCharacter(value[end], scheme))
            end += 1;
        const candidate = value.slice(candidateStart, end);
        const context = { value, start, end };
        result += value.slice(cursor, start);
        if (candidate.length > MAX_INLINE_CREDENTIAL_CHARS ||
            (scanCrossesInput && end === value.length) ||
            isCredential(scheme, candidate, context)) {
            result += "[REDACTED]";
        }
        else {
            result += value.slice(start, end);
        }
        cursor = end;
    }
    return result + value.slice(cursor);
}
function isAuthorizationCharacter(character, scheme) {
    return scheme.toLowerCase() === "basic"
        ? /[A-Za-z0-9+/=]/.test(character)
        : /[A-Za-z0-9._~+/=-]/.test(character);
}
function isBasicCredential(encoded) {
    if (encoded.length < 2 || encoded.length > MAX_INLINE_CREDENTIAL_CHARS)
        return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        return false;
    const normalized = encoded.replace(/=+$/, "");
    if (normalized.length % 4 === 1)
        return false;
    const decoded = Buffer.from(encoded, "base64");
    return decoded.includes(0x3a) && decoded.toString("base64").replace(/=+$/, "") === normalized;
}
function isBearerCredential(candidate, context) {
    if (candidate.length === 0 || candidate.length > MAX_INLINE_CREDENTIAL_CHARS)
        return false;
    if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(candidate))
        return false;
    if (hasBearerCredentialContext(context.value, context.start))
        return true;
    if (isBearerDocumentation(context.value, candidate, context.end))
        return false;
    if (isNaturalLanguageBearerLabel(candidate))
        return false;
    // Outside an explicit header or secret assignment, require an opaque-token
    // shape. Multi-word lowercase documentation labels are handled above; short
    // structured tokens and long opaque runs remain credentials.
    return candidate.length >= 12 || /[0-9._~+/-]/.test(candidate);
}
function isNaturalLanguageBearerLabel(candidate) {
    if (!/^[a-z]+(?:-[a-z]+){3,}$/.test(candidate))
        return false;
    const words = candidate.split("-");
    if (words.some((word) => word.length > 32))
        return false;
    const hasDocumentationMarker = words.some((word) => /^(?:documentation|placeholder|example|overview|reference|guide|syntax|format|sample)$/.test(word));
    if (!hasDocumentationMarker)
        return false;
    const pronounceable = words.every((word) => word === "a" || word === "i" || (word.length >= 2 && /[aeiouy]/.test(word)));
    return pronounceable && words.filter((word) => word.length >= 3).length >= 3;
}
function hasBearerCredentialContext(value, start) {
    const left = value.slice(Math.max(0, start - 128), start);
    if (/(?:^|[\s,;])(?:proxy[- ]?)?(?:auth(?:entication)?|authorization)\s+headers?\s*[:=]\s*["']?\s*$/i.test(left)) {
        return true;
    }
    const assignment = /["']?([A-Za-z][A-Za-z0-9_.\-\[\]"']{0,80})["']?\s*[:=]\s*["']?\s*$/.exec(left);
    if (!assignment)
        return false;
    const key = assignment[1];
    const compact = keySegments(key).join("");
    return isSensitiveKey(key) || compact === "credential" || compact === "credentials" ||
        compact.endsWith("authheader") || compact.endsWith("authorizationheader");
}
function isBearerDocumentation(value, candidate, end) {
    const lower = candidate.toLowerCase();
    const next = value.slice(end, end + 48);
    if (/^(?:authentication|authorization|bearer|documentation|scheme|token)$/.test(lower)) {
        if (lower !== "token" || /^(?:\s+(?:syntax|format|overview|guide|example|documentation|scheme))?\b/i.test(next)) {
            return true;
        }
    }
    const words = lower.split(/[-_.]+/).filter(Boolean);
    const documentationWords = new Set([
        "authentication",
        "authorization",
        "bearer",
        "docs",
        "documentation",
        "example",
        "format",
        "flow",
        "guide",
        "header",
        "http",
        "oauth",
        "overview",
        "reference",
        "rfc",
        "scheme",
        "syntax",
        "token",
        "usage",
        "version",
    ]);
    const meaningful = words.filter((word) => documentationWords.has(word)).length;
    return words.length >= 2 && meaningful >= 2 &&
        words.every((word) => documentationWords.has(word) || /^v?\d+$/.test(word));
}
function redactJwtCredentials(value) {
    return value.replace(/(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,})(?![A-Za-z0-9_-])/g, (candidate) => candidate.length > MAX_INLINE_CREDENTIAL_CHARS || isJwtCredential(candidate)
        ? "[REDACTED]"
        : candidate);
}
function isJwtCredential(candidate) {
    if (candidate.length > MAX_INLINE_CREDENTIAL_CHARS)
        return false;
    const segments = candidate.split(".");
    if (segments.length !== 3 || segments[2].length < 6)
        return false;
    return isJsonObjectSegment(segments[0]) && isJsonObjectSegment(segments[1]);
}
function redactPartialJwt(value, scanCrossesInput) {
    if (!scanCrossesInput)
        return value;
    const segments = [];
    let end = value.length;
    while (segments.length < 3) {
        let start = end;
        while (start > 0 && isBase64UrlCharacter(value[start - 1]))
            start -= 1;
        if (start === end)
            break;
        segments.unshift({ start, end });
        if (start === 0 || value[start - 1] !== ".")
            break;
        end = start - 1;
    }
    if (segments.length === 0)
        return value;
    // No delimiter is visible when an oversized JWT header consumes the entire
    // look-ahead. Require both a long token run and an encoded JSON-object prefix
    // before failing closed, which preserves large ordinary prose/content.
    if (segments.length === 1) {
        const segment = value.slice(segments[0].start, segments[0].end);
        if (segment.length < MAX_INLINE_CREDENTIAL_CHARS || !isJsonObjectSegmentPrefix(segment))
            return value;
        return `${value.slice(0, segments[0].start)}[REDACTED]`;
    }
    const header = segments[0];
    if (!isJsonObjectSegmentOrPrefix(value.slice(header.start, header.end)))
        return value;
    if (segments.length === 3) {
        const payload = segments[1];
        if (!isJsonObjectSegmentOrPrefix(value.slice(payload.start, payload.end)))
            return value;
    }
    return `${value.slice(0, header.start)}[REDACTED]`;
}
function isBase64UrlCharacter(character) {
    return /[A-Za-z0-9_-]/.test(character);
}
function isJsonObjectSegmentOrPrefix(segment) {
    return segment.length <= MAX_INLINE_CREDENTIAL_CHARS
        ? isJsonObjectSegment(segment)
        : isJsonObjectSegmentPrefix(segment);
}
function isJsonObjectSegmentPrefix(segment) {
    const sampleLength = Math.min(segment.length - (segment.length % 4), 1_024);
    if (sampleLength < 4)
        return false;
    const encoded = segment.slice(0, sampleLength);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded)
        return false;
    return /^\s*\{\s*"[^"\\]{1,128}"\s*:/.test(decoded.toString("utf8"));
}
function isJsonObjectSegment(segment) {
    if (segment.length > MAX_INLINE_CREDENTIAL_CHARS ||
        !BASE64URL_SEGMENT.test(segment) ||
        segment.length % 4 === 1)
        return false;
    try {
        const decoded = Buffer.from(segment, "base64url");
        if (decoded.toString("base64url") !== segment.replace(/=+$/, ""))
            return false;
        const value = JSON.parse(decoded.toString("utf8"));
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    catch {
        return false;
    }
}
function redactCredentialUrls(value) {
    return value.replace(/(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s<>"'`]+/gi, (raw) => redactCredentialUrl(raw));
}
function redactCredentialUrl(raw) {
    const trailing = /[),.;!?]+$/.exec(raw)?.[0] ?? "";
    const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        return raw;
    }
    let changed = false;
    if (url.username || url.password) {
        url.username = "REDACTED";
        url.password = "";
        changed = true;
    }
    for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveUrlParameter(key)) {
            url.searchParams.set(key, "REDACTED");
            changed = true;
        }
    }
    const fragment = url.hash.slice(1);
    const fragmentPrefix = fragment.startsWith("?") ? "?" : "";
    const fragmentForm = fragmentPrefix ? fragment.slice(1) : fragment;
    if (isFormLikeFragment(fragmentForm)) {
        const params = new URLSearchParams(fragmentForm);
        let fragmentChanged = false;
        for (const key of [...params.keys()]) {
            if (isSensitiveUrlParameter(key)) {
                params.set(key, "REDACTED");
                fragmentChanged = true;
            }
        }
        if (fragmentChanged) {
            url.hash = `${fragmentPrefix}${params.toString()}`;
            changed = true;
        }
    }
    return changed ? `${url.toString()}${trailing}` : raw;
}
function isFormLikeFragment(fragment) {
    return fragment.split("&").some((field) => /^[^=&#]+=[^&#]*$/.test(field));
}
function isSensitiveUrlParameter(key) {
    if (isSensitiveKey(key))
        return true;
    return semanticKeyMatches(keySegments(key), URL_ONLY_SENSITIVE_KEYS);
}
function isSensitiveKey(key) {
    const segments = keySegments(key);
    return semanticKeyMatches(segments, EXACT_SENSITIVE_KEYS) ||
        semanticKeyMatches(segments, SENSITIVE_KEY_SUFFIXES);
}
function semanticKeyMatches(segments, sensitive) {
    for (let start = 0; start < segments.length; start += 1) {
        let compact = "";
        for (let end = start; end < Math.min(segments.length, start + 4); end += 1) {
            compact += segments[end];
            if (!sensitive.has(compact))
                continue;
            if (segments.slice(end + 1).some((next) => SAFE_KEY_QUALIFIERS.has(next)))
                continue;
            return true;
        }
    }
    return false;
}
function keySegments(key) {
    return key
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9]+/)
        .map((segment) => segment.toLowerCase())
        .filter(Boolean);
}
export function redactText(value) {
    return redactString(value, {}, { truncated: false });
}
export function contentHash(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function safeError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return redactText(message).replace(/[\r\n]+/g, " ").slice(0, 500);
}
//# sourceMappingURL=redaction.js.map