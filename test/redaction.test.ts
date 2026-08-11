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
