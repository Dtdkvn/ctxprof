# Importing captures

Offline analysis is the safest way to start because it is deterministic, reviewable, and needs no provider credential.

## Raw request

```json
{
  "model": "gpt-5.6-terra",
  "messages": [
    { "role": "system", "content": "Answer briefly." },
    { "role": "user", "content": "Hello" }
  ]
}
```

Run `ctxprof analyze request.json`.

## Exchange wrapper

Provider usage and response tool calls improve total/cost and unused-tool attribution:

```json
{
  "captured_at": "2026-08-11T10:00:00Z",
  "prompt_version": "checkout-v4",
  "label": "Checkout assistant",
  "request": { "model": "gpt-5.6-terra", "messages": [] },
  "response": {
    "model": "gpt-5.6-terra",
    "choices": [],
    "usage": { "prompt_tokens": 1200, "completion_tokens": 80 }
  }
}
```

The wrapper also accepts `endpoint`, `status`, and `duration_ms`.

## JSONL and Batch records

Each non-empty JSONL line may be a raw request, wrapper, normalized `ProfileRun`, or OpenAI Batch-style request with `custom_id`, `url`, and `body`. Normalized runs are validated fail-closed: every metric must be finite, non-negative, internally consistent, and within the storage/component bounds. Multi-record case names receive stable `#N` suffixes in budget output; colliding basenames use normalized config-relative paths so input order cannot swap baseline identities.

Each input path is also coverage-significant: it must produce at least one supported record. An empty JSONL file or JSON array fails even when another input is valid, so a truncated fixture cannot silently disappear from analysis or CI.

## HAR

Ctxprof reads entries whose `request.postData.text` is valid JSON. It reads JSON response content, including base64-encoded HAR bodies, but never imports HAR request/response headers.

An empty HAR or one with no supported JSON request entry fails with the file path and expected formats. A `.har` file is never reinterpreted as a generic request when its HAR structure is malformed.

Export HAR files only from approved environments. They often contain credentials and cookies even though Ctxprof ignores those fields. Sanitize or delete the original HAR after extracting the needed request bodies.

## Overrides

```bash
ctxprof import captures.jsonl \
  --prompt-version candidate-12 \
  --label "refund agent" \
  --model my-provider/model-v2 \
  --capture none
```

Explicit CLI values override metadata in the file. Unknown cost stays unknown unless the exact model is in `--pricing`.
