import { createHash } from "node:crypto";
const SENSITIVE_KEYS = /(?:^|[_-])(api[_-]?key|authorization|auth|bearer|cookie|password|passwd|secret|session|token|private[_-]?key|client[_-]?secret)(?:$|[_-])/i;
const SECRET_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    // JSON Web Tokens: header and payload are base64url-encoded JSON objects, so
    // both begin with `eyJ` ("{\""). Requiring that on the first two segments keeps
    // the match high-confidence and the pattern linear (no catastrophic backtracking).
    /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    /\bsk-[A-Za-z0-9_-]{12,}\b/g,
    /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
];
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
    let result = value;
    for (const pattern of SECRET_PATTERNS)
        result = result.replace(pattern, "[REDACTED]");
    if (options.redactEmails) {
        result = result.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
    }
    const max = options.maxStringChars ?? 16_384;
    if (result.length > max) {
        state.truncated = true;
        result = `${result.slice(0, max)}…[TRUNCATED ${result.length - max} chars]`;
    }
    return result;
}
function isSensitiveKey(key) {
    if (SENSITIVE_KEYS.test(key))
        return true;
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (compact.includes("apikey") ||
        compact.includes("password") ||
        compact.includes("privatekey") ||
        compact.includes("clientsecret") ||
        compact.includes("awssecretaccesskey") ||
        compact === "authorization" ||
        compact === "auth" ||
        compact === "cookie" ||
        compact === "secret" ||
        compact === "session" ||
        compact === "token" ||
        compact === "jwt" ||
        compact.endsWith("apitoken") ||
        compact.endsWith("authtoken") ||
        compact.endsWith("bearertoken") ||
        compact.endsWith("sessiontoken") ||
        compact.endsWith("accesstoken") ||
        compact.endsWith("refreshtoken") ||
        compact.endsWith("idtoken") ||
        compact.endsWith("sessionid") ||
        compact.endsWith("signingsecret") ||
        compact.endsWith("webhooksecret"));
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