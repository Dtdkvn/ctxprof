# Privacy guide

Ctxprof is local-first, not zero-knowledge. It must read a prompt to profile it. The goal is to minimize accidental persistence and network exposure while keeping that boundary explicit.

## Capture modes

### `redacted` (default)

The normalized component profile, short redacted previews, and a redacted/capped request-response exchange are stored. The live dashboard polls summary projections and fetches component detail for only the selected run; the stored exchange is not sent to the browser.

Use it only when storing a sanitized version of the traffic on the machine is acceptable.

### `none`

The exchange body and component previews are omitted. Component labels, counts, shares, and content hashes remain for duplicate detection and budget comparisons. This rule also applies to library calls: `captureMode: "none"` always wins over `previewChars`.

```bash
ctxprof proxy --capture none
ctxprof import approved.json --capture none
```

For highly sensitive data, create a synthetic fixture that preserves shape and size instead of proxying real traffic.

## What is redacted

- values below common secret-like keys, including authorization, API keys, cookies, passwords, private keys, secrets, sessions, and tokens;
- bearer credentials, JSON Web Tokens (JWTs), and common OpenAI, GitHub, AWS, and PEM private-key patterns embedded in strings;
- safe error messages before printing;
- long strings and oversized full exchanges.

Ordinary request and response headers are never copied into analysis records. The explicit `x-ctxprof-label` and `x-ctxprof-version` values are converted into bounded, redacted run metadata and are never forwarded upstream.

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

The native CLI refuses non-loopback binds without `--allow-remote`. A remote reverse-proxy domain also needs an exact repeatable `--allowed-host <hostname>`; schemes, ports, paths, and wildcards are rejected. Docker must listen on `0.0.0.0` inside its network namespace, but the supplied Compose file maps the port to host `127.0.0.1` only.

There is no dashboard authentication. For approved shared access, add TLS and identity-aware authentication in a reverse proxy, restrict source networks, and treat the JSON API as sensitive.

## Telemetry

Ctxprof has no analytics, update check, crash reporter, hosted service, or third-party UI resource. The only intended outbound request in proxy mode is the model request to the operator-configured upstream. Offline import, analysis, reporting, comparison, and budget checks do not require network access.
