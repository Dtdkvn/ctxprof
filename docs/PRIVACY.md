# Privacy guide

Ctxprof is local-first, not zero-knowledge. It must read a prompt to profile it. The goal is to minimize accidental persistence and network exposure while keeping that boundary explicit.

## Capture modes

### `redacted` (default)

The normalized component profile, short redacted previews, and a redacted/capped request-response exchange are stored. This is convenient for local debugging and the interactive detail panel.

Use it only when storing a sanitized version of the traffic on the machine is acceptable.

### `none`

The exchange body is omitted. Component labels, counts, shares, and short previews are still produced by the CLI/proxy analyzer. Library users can also set `previewChars: 0` to remove snippets. Content hashes remain for duplicate detection.

```bash
ctxprof proxy --capture none
ctxprof import approved.json --capture none
```

For highly sensitive data, create a synthetic fixture that preserves shape and size instead of proxying real traffic.

## What is redacted

- values below common secret-like keys, including authorization, API keys, cookies, passwords, private keys, secrets, sessions, and tokens;
- bearer credentials and common OpenAI, GitHub, AWS, and PEM private-key patterns embedded in strings;
- safe error messages before printing;
- long strings and oversized full exchanges.

Headers are never copied into analysis records at all.

## What may remain

Names, addresses, emails, order IDs, source code, proprietary policies, database rows, uncommon credential formats, and anything else that does not match a conservative secret rule may remain. Email redaction is available through the library API but is not the default because email-like text can be required context.

Always inspect a generated report before sharing it.

## Storage lifecycle

Ctxprof writes `.ctxprof/runs.jsonl` and does not expose a delete API. This makes retention a visible filesystem operation rather than a hidden dashboard side effect.

- `.ctxprof/` is in this repository's `.gitignore`.
- Owner-only POSIX modes are requested, but Windows ACLs and mounted filesystems vary.
- Use full-disk encryption.
- Exclude the directory from automatic cloud sync and support bundles unless approved.
- A self-contained HTML report omits full stored exchanges, but embeds component profiles and redacted previews and remains sensitive.

## Network exposure

The native CLI refuses non-loopback binds without `--allow-remote`. Docker must listen on `0.0.0.0` inside its network namespace, but the supplied Compose file maps the port to host `127.0.0.1` only.

There is no dashboard authentication. For approved shared access, add TLS and identity-aware authentication in a reverse proxy, restrict source networks, and treat the JSON API as sensitive.

## Telemetry

Ctxprof has no analytics, update check, crash reporter, hosted service, or third-party UI resource. The only intended outbound request in proxy mode is the model request to the operator-configured upstream. Offline import, analysis, reporting, comparison, and budget checks do not require network access.
