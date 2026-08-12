# Security policy

Ctxprof sits on a sensitive trust boundary: prompts, tool results, model outputs, and API credentials pass through the proxy. This document states what the project protects, what it does not, and how to deploy it safely.

## Supported versions

Security fixes are applied to the latest minor release. Before a `1.0.0` release, upgrades may include documented breaking changes when they reduce data exposure.

## Reporting a vulnerability

Do not open a public issue for a vulnerability or include real prompts, credentials, or capture files in a report. Use GitHub's **Report a vulnerability** flow under the repository Security tab. Include the affected version, impact, a minimal reproduction with synthetic data, and any suggested mitigation.

Maintainers should acknowledge a complete report within three business days, provide a triage decision within seven days, and coordinate disclosure after a fix is available.

## Trust model

### What Ctxprof protects

- The default server binds to loopback and rejects a non-loopback bind without `--allow-remote`.
- Ordinary headers are used only for forwarding and are never included in a `ProfileRun`. The explicit `x-ctxprof-label` and `x-ctxprof-version` values are converted to bounded, redacted run metadata and are not forwarded.
- `Authorization` and `OPENAI_API_KEY` values are never printed.
- Stored exchange bodies pass through recursive key-based and pattern-based secret redaction.
- Proxy requests are capped at 5 MiB. Normalized components, warnings, and serialized runs have hard bounds; high-cardinality detail is accumulated into bounded per-kind hashes and totals before component objects or warnings are created, and an exchange over the storage limit is replaced by a one-way content hash and notice.
- `--capture none` omits request/response bodies and all component previews while keeping component metrics and short hashes.
- Store files use owner-only POSIX modes where the filesystem supports them.
- The browser UI has no third-party scripts, styles, fonts, analytics, or telemetry.
- The live server sends a restrictive Content Security Policy, `nosniff`, and no-referrer headers. Its conditional feed excludes exchanges, component previews, and warnings; the selected detail projection is fetched separately and still excludes the stored exchange. Static reports embed an equivalent CSP meta policy and disable network connections.

### What Ctxprof does not protect

- The store is **not encrypted at rest**. Filesystem permissions are best effort, especially on Windows and network volumes.
- Pattern redaction cannot recognize every customer identifier, business secret, access token format, or private fact.
- The dashboard has **no authentication**. `--allow-remote` is an expert override, not an access-control feature.
- A self-contained HTML report contains component profiles and redacted previews (not the full stored exchange) and should still be handled like an internal diagnostic artifact.
- Request content is forwarded unchanged to the configured upstream. Ctxprof cannot improve that provider's data handling.
- A malicious local administrator, compromised Node runtime, modified package, or process-level debugger can read data in memory.
- Component content hashes are unkeyed truncated SHA-256 identifiers. They help recognize repeats, but low-entropy content may be guessable.
- The proxy does not terminate untrusted public traffic, provide tenant isolation, or enforce user authorization.

## Safe deployment checklist

1. Use synthetic or staging traffic first.
2. Keep the default `127.0.0.1` bind. The supplied Compose file publishes only on host loopback.
3. Prefer `--capture none` for regulated, customer, health, financial, or source-code traffic.
4. Store `.ctxprof/` on an encrypted local disk and exclude it from Git, backups, crash uploads, and support bundles unless explicitly approved.
5. Review exported HTML before sharing it.
6. Use a dedicated, least-privilege upstream API key and normal provider spend limits.
7. If team access is necessary, put Ctxprof behind an authenticated reverse proxy on a trusted network and use `--allow-remote --allowed-host ctxprof.example`; do not expose it directly to the internet. Each repeatable allowed-host value is an exact hostname without a scheme, port, path, or wildcard.
8. Keep Node.js and Ctxprof patched. Pin release tags or package-lock integrity in automation.

## Proxy behavior

Every request must use an allowed Host; wildcard remote binds accept only literal local/socket IPs and localhost unless an exact `--allowed-host` is configured. Browser requests with an Origin must also be same-origin. These checks reduce DNS-rebinding exposure but do not add authentication.

The proxy accepts JSON POSTs below `/v1/` and forwards request headers through a positive allowlist: authorization, JSON content metadata, `Accept`, `User-Agent`, `Idempotency-Key`, `OpenAI-*`, Stainless SDK metadata, and exact Anthropic/Azure/Google auth, version, beta, and project headers. All other incoming headers are dropped by default, so new CDN or identity-proxy headers cannot silently cross the provider boundary. A repeatable `--forward-header <name>` is a deliberate custom-provider opt-in; unsafe hop-by-hop, forwarding, browser, and Ctxprof metadata names are rejected. Treat every opted-in value as data disclosed to the upstream. Responses strip `Set-Cookie`. The proxy does not log query strings or bodies, and the configured upstream origin is printed without credentials. The upstream deadline defaults to 120 seconds and is configurable with `--upstream-timeout-ms` or `CTXPROF_UPSTREAM_TIMEOUT_MS`.

Redirects are not followed. TLS validation is delegated to Node's standard HTTPS client. Do not disable TLS verification in production.

## Redaction details

Sensitive object keys include common spellings of authorization, API keys, cookies, passwords, sessions, private keys, secrets, and tokens. Inline patterns include bearer credentials, JSON Web Tokens (JWTs), common OpenAI/GitHub/AWS key shapes, and PEM private keys. Email redaction is available through the library redaction API but is not enabled by default because email-like strings can be legitimate prompt data.

Redaction happens before persistence, but profiling necessarily sees the original request in process memory. If that is unacceptable, analyze an already-sanitized fixture instead of using proxy mode.

## Dependency and build posture

Production code has zero third-party runtime packages and requires a maintained Node.js 22+ release. Releases still depend on the Node runtime, the package registry, GitHub Actions, and the development compiler. Lockfile integrity, SHA-pinned Actions, trusted npm publishing, CI on Node 22/24, installed-tarball smoke tests, and a digest-pinned multi-stage container build reduce but do not eliminate supply-chain risk.

Networks with a TLS-inspecting corporate proxy can pass its trusted PEM bundle to BuildKit without baking it into the image: `docker build --secret id=ctxprof_ca,src=/path/to/ca.pem .`. `NODE_EXTRA_CA_CERTS` extends Node's public trust roots for that build step; Ctxprof never requires disabling npm TLS verification.
