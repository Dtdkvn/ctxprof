import assert from "node:assert/strict";
import test from "node:test";
import { redactText, redactValue } from "../src/redaction.js";

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

test("redacts common camelCase token and identity secret keys", () => {
  const input = {
    apiToken: "synthetic-api-token",
    authToken: "synthetic-auth-token",
    sessionToken: "synthetic-session-token",
    awsSecretAccessKey: "synthetic-aws-secret",
    sessionId: "synthetic-session-id",
    signingSecret: "synthetic-signing-secret",
    webhookSecret: "synthetic-webhook-secret",
  };
  const result = redactValue(input).value as Record<string, unknown>;
  for (const key of Object.keys(input)) assert.equal(result[key], "[REDACTED]");
});

test("redacts common inline secret formats and truncates", () => {
  const inline = redactText("token sk-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz");
  assert.doesNotMatch(inline, /sk-|ghp_/);
  const result = redactValue("x".repeat(100), { maxStringChars: 10 });
  assert.equal(result.truncated, true);
  assert.match(String(result.value), /TRUNCATED/);
});

test("redacts bare JWT credentials inside strings and non-sensitive keys", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.doesNotMatch(redactText(`session token is ${jwt} keep going`), /eyJ/);
  const nested = redactValue({ note: `auth ${jwt}`, list: [jwt] }).value as {
    note: string;
    list: string[];
  };
  assert.doesNotMatch(nested.note, /eyJ/);
  assert.doesNotMatch(String(nested.list[0]), /eyJ/);
  // A dotted, non-JWT value (no eyJ segments) must not be over-redacted.
  const benign = "path.to.value";
  assert.equal(redactText(benign), benign);
});

test("redacts a credential that appears as a property name", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz";
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const serialized = JSON.stringify(
    redactValue({ quotas: { [key]: { limit: 5 } }, sessions: { [jwt]: 1 } }).value,
  );
  assert.doesNotMatch(serialized, /sk-abcdefghij/);
  assert.doesNotMatch(serialized, /eyJ/);
  // Ordinary property names must survive untouched.
  const kept = redactValue({ model: { temperature: 0.2 } }).value as Record<string, unknown>;
  assert.deepEqual(kept, { model: { temperature: 0.2 } });
});
