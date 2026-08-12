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
    AWSSecretAccessKey: "value",
    AWSAccessKeyId: "value",
    awsAccessKeyId: "value",
    AWS_ACCESS_KEY_ID: "value",
    AwsAccessKeyId: "value",
    accessKeyId: "value",
    access_key_id: "value",
    JWTToken: "value",
    "X-Goog-Signature": "value",
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
    AWSAccessKeyIdHint: "last four characters only",
    accessKeyIdHint: "last four characters only",
    AWSSecretAccessKeyPolicy: "managed externally",
    JWTTokenCount: 3,
    "X-Goog-Signature-Mode": "v4",
    secretAlgorithm: "HMAC-SHA256",
    tokenType: "bearer",
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
  const shortBearerTokens = [
    "abc.def.ghi",
    "token-value",
    "opaque-token-123",
    "0123456789abcdef",
    "dXNlcjpzZWNyZXQ=",
    "abc",
  ] as const;

  const text = redactText(
    `bot=${slackBot} user=${slackUser} app=${slackApp} google=${googleApiKey} ` +
    `Authorization: Basic ${basic}. proxy-authorization: bAsIc\t${minimalBasic} ` +
    `Bearer ${bearer} Bearer ${lowEntropyBearer} ` +
    `Authorization: Bearer ${shortBearerTokens[0]} ` +
    `headers.authorization=Bearer ${shortBearerTokens[1]} ` +
    `proxy-authorization: Bearer ${shortBearerTokens[2]} ` +
    `authHeader: Bearer ${shortBearerTokens[3]} ` +
    `credential=Bearer ${shortBearerTokens[4]} ` +
    `Authorization header: Bearer ${shortBearerTokens[5]}`,
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
    ...shortBearerTokens,
  ]) {
    assert.ok(!text.includes(credential), `${credential.slice(0, 8)} credential must be redacted`);
  }
  assert.match(text, /\[REDACTED\]\. proxy-authorization/);

  const propertyNames = JSON.stringify(redactValue({
    [slackBot]: 1,
    [googleApiKey]: 2,
    [`Basic ${basic}`]: 3,
    [`Authorization: Bearer ${shortBearerTokens[0]}`]: 4,
  }).value);
  for (const credential of [slackBot, googleApiKey, basic, shortBearerTokens[0]]) {
    assert.ok(!propertyNames.includes(credential));
  }

  const safeMessage = safeError(new Error(`Authorization: Bearer ${shortBearerTokens[1]}`));
  assert.ok(!safeMessage.includes(shortBearerTokens[1]!));

  for (const benign of [
    "xoxb-short-example",
    `prefix${slackBot}`,
    `${googleApiKey}suffix`,
    "Basic authentication uses a user name and password.",
    "Basic Zm9v",
    "Bearer authentication overview",
    "Bearer token syntax",
    "Bearer authentication-reference-guide-version-2026",
    "Bearer authentication-overview",
    "Bearer authentication_documentation",
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

  const oversizedHeader = encode({ alg: "HS256", padding: "x".repeat(50_000) });
  assert.ok(oversizedHeader.length > 65_000);
  const oversizedJwt = `${oversizedHeader}.${encode({ secret: "y".repeat(50_000) })}.synthetic-signature`;
  const oversizedJwtResult = redactText(oversizedJwt);
  assert.ok(!oversizedJwtResult.includes(oversizedHeader.slice(0, 100)));
  const visibleDelimiterHeader = encode({ alg: "HS256", padding: "x".repeat(30_000) });
  assert.ok(visibleDelimiterHeader.length > 32_768 && visibleDelimiterHeader.length < 49_000);
  const visibleDelimiterJwt = `${visibleDelimiterHeader}.${encode({ secret: "z".repeat(50_000) })}.signature`;
  assert.ok(!redactText(visibleDelimiterJwt).includes(visibleDelimiterHeader.slice(0, 100)));
  assert.match(redactText(`large-private-exchange-${"x".repeat(300_000)}`), /large-private-exchange/);

  const boundaryBasic = Buffer.from(`user:${"p".repeat(60_000)}`).toString("base64");
  const boundaryBasicResult = redactText(`${"x".repeat(16_360)} Basic ${boundaryBasic}`);
  assert.ok(!boundaryBasicResult.includes(boundaryBasic.slice(0, 100)));

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

  const variantUrl =
    "https://example.test/callback?accessToken=query-access&refreshToken=query-refresh" +
    "&clientSecret=query-client&authToken=query-auth&sessionToken=query-session" +
    "&access-token=query-hyphen&X-Amz-Credential=amz-credential" +
    "&AWSAccessKeyId=aws-access&GoogleAccessId=google-access" +
    "#access_token=fragment-access&refreshToken=fragment-refresh&state";
  const variantRedacted = redactText(variantUrl);
  for (const secret of [
    "query-access",
    "query-refresh",
    "query-client",
    "query-auth",
    "query-session",
    "query-hyphen",
    "amz-credential",
    "aws-access",
    "google-access",
    "fragment-access",
    "fragment-refresh",
  ]) assert.ok(!variantRedacted.includes(secret), secret);

  const variantProperty = JSON.stringify(redactValue({ [variantUrl]: 1 }).value);
  assert.doesNotMatch(variantProperty, /query-access|fragment-access|amz-credential/);
  assert.doesNotMatch(safeError(new Error(variantUrl)), /query-access|fragment-access|amz-credential/);

  for (const benign of [
    "https://example.test/docs#access-token-guide",
    "https://example.test/docs#section=access_token",
    "https://example.test/docs#token_count=7&mode=read",
    "https://example.test/?algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&file=demo" +
      "&accessKeyIdHint=last-four&GoogleAccessIdHint=last-four",
    "https://example.test/?code_challenge=public-hash&tokenType=bearer&signatureVersion=v4",
  ]) assert.equal(redactText(benign), benign);
});

test("redacts userinfo from hierarchical service URLs without broad scheme matching", () => {
  const urls = [
    "postgresql://db-user:db-password@db.example.test/app",
    "redis://cache-user:cache-password@cache.example.test/0",
    "mongodb+srv://mongo-user:mongo-password@cluster.example.test/app",
    "amqp://queue-user:queue-password@queue.example.test/vhost",
    "POSTGRESQL://upper-user:upper-password@db.example.test/app",
  ];
  const text = redactText(urls.join(" "));
  for (const secret of ["db-user", "db-password", "cache-user", "cache-password", "mongo-user", "mongo-password", "queue-user", "queue-password", "upper-user", "upper-password"]) {
    assert.ok(!text.includes(secret), secret);
  }

  const propertyNames = JSON.stringify(redactValue({ [urls[0]!]: 1 }).value);
  assert.doesNotMatch(propertyNames, /db-user|db-password/);
  assert.doesNotMatch(safeError(new Error(urls[2]!)), /mongo-user|mongo-password/);

  for (const benign of [
    "postgresql://db.example.test/app",
    "mailto:alice@example.test",
    "postgresql connection overview",
  ]) assert.equal(redactText(benign), benign);
});

function jwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${encode(header)}.${encode(payload)}.synthetic-signature`;
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
