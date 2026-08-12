import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { safeError, redactText, redactValue } from "../src/redaction.js";

test("redacts sensitive keys recursively without mutating input", () => {
  const input = {
    api_key: "sk-live-abcdefghijkl",
    openaiApiKey: "sk-camel-case-secret",
    nested: { authorization: "Bearer abc.def.ghi", accessToken: "token-value", safe: "hello" },
  };
  const result = redactValue(input);
  assert.deepEqual(result.value, {
    api_key: "[REDACTED]",
    openaiApiKey: "[REDACTED]",
    nested: { authorization: "[REDACTED]", accessToken: "[REDACTED]", safe: "hello" },
  });
  assert.equal(input.api_key, "sk-live-abcdefghijkl");
});

test("recognizes sensitive key segments while preserving safe metadata", () => {
  const sensitive = {
    apiToken: "value",
    authToken: "value",
    sessionToken: "value",
    awsSecretAccessKey: "value",
    sessionId: "value",
    signingSecret: "value",
    webhookSecret: "value",
    "headers.authorization": "value",
    "headers[authorization]": "value",
    secretKey: "value",
    apiSecret: "value",
    consumerSecret: "value",
  };
  const redacted = redactValue(sensitive).value as Record<string, unknown>;
  for (const key of Object.keys(sensitive)) assert.equal(redacted[key], "[REDACTED]", key);

  const safe = {
    token_count: 7,
    session_duration_ms: 250,
    password_policy: "strong",
    authorization_mode: "oauth",
    cookie_banner: true,
    secret_sauce_recipe: "tomato",
    auth_method: "pkce",
    api_key_hint: "last four characters only",
  };
  assert.deepEqual(redactValue(safe).value, safe);
});

test("redacts common inline secret formats and truncates", () => {
  const inline = redactText(
    "token sk-abcdefghijklmnopqrstuvwxyz, ghp_abcdefghijklmnopqrstuvwxyz, " +
    "AKIAABCDEFGHIJKLMNOP, and ASIAABCDEFGHIJKLMNOP",
  );
  assert.doesNotMatch(inline, /sk-|ghp_|AKIA|ASIA/);
  const result = redactValue("x".repeat(100), { maxStringChars: 10 });
  assert.equal(result.truncated, true);
  assert.match(String(result.value), /TRUNCATED/);
});

test("validates JWT objects before redacting including an empty payload", () => {
  const regularJwt = jwt({ alg: "HS256", typ: "JWT" }, { sub: "123" });
  const emptyPayloadJwt = jwt({ alg: "HS256" }, {});
  const nested = redactValue({ note: `auth ${regularJwt}`, list: [emptyPayloadJwt] }).value as {
    note: string;
    list: string[];
  };
  assert.equal(nested.note, "auth [REDACTED]");
  assert.equal(nested.list[0], "[REDACTED]");
  assert.equal(redactText("path.to.value"), "path.to.value");
  assert.equal(redactText("eyJub3QiOiJjbG9zZWQ.aW52YWxpZA.signature"), "eyJub3QiOiJjbG9zZWQ.aW52YWxpZA.signature");
  assert.equal(redactText("e30.e30.short"), "e30.e30.short");
});

test("redacts credentials that appear as property names", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz";
  const token = jwt({ alg: "HS256" }, {});
  const serialized = JSON.stringify(
    redactValue({ quotas: { [key]: { limit: 5 } }, sessions: { [token]: 1 } }).value,
  );
  assert.doesNotMatch(serialized, /sk-abcdefghij/);
  assert.ok(!serialized.includes(token));
  assert.deepEqual(redactValue({ model: { temperature: 0.2 } }).value, { model: { temperature: 0.2 } });
});

test("redacts provider and authorization credentials without broad matches", () => {
  const slackBot = "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwxyz";
  const slackUser = "xoxp-123456789012-123456789012-abcdefghijklmnopqrstuvwxyz";
  const slackApp = "xapp-1-ABCDEFGHIJKLMNOPQRSTUVWXYZ-1234567890";
  const googleApiKey = `AIza${"A".repeat(35)}`;
  const basic = Buffer.from("synthetic-user:synthetic-password").toString("base64");
  const minimalBasic = Buffer.from(":").toString("base64");
  const bearer = "AbCdEfGhIjKlMnOpQrStUvWxYz_12345";
  const lowEntropyBearer = "a".repeat(40);

  const text = redactText(
    `bot=${slackBot} user=${slackUser} app=${slackApp} google=${googleApiKey} ` +
    `Authorization: Basic ${basic}. proxy-authorization: bAsIc\t${minimalBasic} ` +
    `Bearer ${bearer} Bearer ${lowEntropyBearer}`,
  );
  for (const credential of [
    slackBot,
    slackUser,
    slackApp,
    googleApiKey,
    basic,
    minimalBasic,
    bearer,
    lowEntropyBearer,
  ]) {
    assert.ok(!text.includes(credential), `${credential.slice(0, 8)} credential must be redacted`);
  }
  assert.match(text, /\[REDACTED\]\. proxy-authorization/);

  const propertyNames = JSON.stringify(redactValue({
    [slackBot]: 1,
    [googleApiKey]: 2,
    [`Basic ${basic}`]: 3,
  }).value);
  for (const credential of [slackBot, googleApiKey, basic]) assert.ok(!propertyNames.includes(credential));

  for (const benign of [
    "xoxb-short-example",
    `prefix${slackBot}`,
    `${googleApiKey}suffix`,
    "Basic authentication uses a user name and password.",
    "Basic Zm9v",
    "Bearer authentication overview",
    "Bearer token syntax",
  ]) assert.equal(redactText(benign), benign);
});

test("redacts bounded oversized Basic credentials fail closed", () => {
  const encoded = Buffer.from(`user:${"p".repeat(13_000)}`).toString("base64");
  assert.ok(encoded.length > 8_192 && encoded.length < 32_768);
  const redacted = redactText(`Basic ${encoded}`);
  assert.ok(!redacted.includes(encoded.slice(0, 100)));
  assert.match(redacted, /^\[REDACTED\](?:…\[TRUNCATED \d+ chars\])?$/);
});

test("fails closed when bounded scanning cuts through a private key or JWT", () => {
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(60_000)}\n-----END PRIVATE KEY-----`;
  const privateResult = redactText(privateKey);
  assert.doesNotMatch(privateResult, /BEGIN PRIVATE KEY|A{100}/);

  const jwtPrefix = `${encode({ alg: "HS256" })}.${"e".repeat(60_000)}`;
  const jwtResult = redactText(jwtPrefix);
  assert.doesNotMatch(jwtResult, /eyJhbGci|e{100}/);

  const started = performance.now();
  redactText(`Basic ${"A".repeat(2_000_000)}`);
  assert.ok(performance.now() - started < 1_000, "redaction work must stay bounded on a large string");
});

test("redacts credentials from URL userinfo and sensitive query parameters", () => {
  const raw =
    "request https://alice:password@example.test/v1?api_key=secret-value&access_token=token-value&mode=safe.";
  const redacted = redactText(raw);
  assert.doesNotMatch(redacted, /alice|password|secret-value|token-value/);
  assert.match(redacted, /mode=safe/);
  assert.match(redacted, /REDACTED/);

  const key = "https://user:pass@example.test/?refresh_token=private&limit=5";
  const serialized = JSON.stringify(redactValue({ [key]: 1 }).value);
  assert.doesNotMatch(serialized, /user|pass|private/);
  assert.match(serialized, /limit=5/);
  assert.equal(redactText("https://example.test/docs?token_count=7"), "https://example.test/docs?token_count=7");
  assert.doesNotMatch(safeError(new Error(raw)), /alice|password|secret-value|token-value/);

  const signed = redactText(
    "https://storage.example.test/object?x-amz-signature=private&x-amz-security-token=session&code=oauth-code&file=demo",
  );
  assert.doesNotMatch(signed, /private|session|oauth-code/);
  assert.match(signed, /file=demo/);
  assert.equal(
    redactText("https://example.test/?file=demo&mode=read&token_count=7"),
    "https://example.test/?file=demo&mode=read&token_count=7",
  );
});

function jwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${encode(header)}.${encode(payload)}.synthetic-signature`;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
