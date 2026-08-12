# Ctxprof launch kit

This file contains copy and checks for the first public release. It does not claim that the repository, npm package, or release tag already exists. The canonical destination is <https://github.com/Dtdkvn/ctxprof>.

## Repository profile

### About

> Local-first context-window profiler for LLM apps: inspect token composition, compare prompt versions, and fail CI on context regressions.

### Topics

`llm`, `openai`, `prompt-engineering`, `context-window`, `token-usage`, `ai-observability`, `developer-tools`, `cli`, `github-actions`, `typescript`

### One-line pitch

Ctxprof turns an opaque LLM token total into an explainable context profile, a prompt-version diff, and a CI budget your team can review like code.

## Launch article

### Your LLM prompt has a bundle-size problem

LLM applications rarely send just the message a user typed. A production request can include a system policy, developer instructions, dozens of tool schemas, conversation history, retrieved documents, tool results, and a response schema. The provider may report one input-token total, but that number does not tell you which part grew or what to change safely.

Ctxprof is a local-first context-window profiler for OpenAI-compatible applications. It breaks an input into the components engineers can act on: system and developer prompts, individual tool definitions, messages, tool results, and structured response material. The interactive treemap makes the largest pieces obvious. Explainable warnings point to measurable candidates such as an oversized schema, a repeated block, or a tool result dominating the request.

The goal is not automatic prompt deletion. An unused tool in one capture is evidence about that capture, not proof that the tool is unnecessary. Ctxprof keeps the advice reversible: inspect representative traffic, compare versions, and validate behavior before removing context.

You can start without an API key. The deterministic demo includes a deliberately bloated support prompt and a leaner revision. Until the first npm release is published, clone the repository, run `npm ci && npm run build`, then use `node dist/cli.js demo` and `node dist/cli.js serve`. The same source checkout can analyze JSON, JSONL, OpenAI Batch records, or sanitized HAR files without sending them to a hosted service.

For live traffic, Ctxprof can sit in front of an OpenAI-compatible Chat Completions or Responses API endpoint. Change the SDK base URL and keep the rest of the request flow intact. The proxy forwards JSON and streaming responses, then profiles a bounded copy. It listens on loopback by default, follows no redirects, and forwards only an explicit header allowlist unless the operator opts in to another provider header.

Privacy is a boundary, not a slogan. Ordinary request and response headers are never stored. Common credential formats and semantic secret fields are redacted before persistence, stored exchanges are capped, and `--capture none` removes bodies and previews while retaining metrics and hashes. The dashboard stays local and unauthenticated, so it must not be exposed directly to an untrusted network. Pattern redaction also cannot find every private fact; sensitive teams should prefer synthetic fixtures and encrypted local storage. The full limits are documented in the [privacy guide](PRIVACY.md) and [security policy](../SECURITY.md).

The other half of Ctxprof is change control. Give captures stable prompt-version labels and compare aggregate A-to-B token, cost, component, and warning deltas. Commit a baseline with representative fixtures, define absolute and regression limits, and run `ctxprof check` in CI. A failed budget identifies the cases and components that crossed the line instead of reducing the result to a generic token-count failure.

The GitHub Action is prebuilt JavaScript for the Node 24 Action runtime, so caller workflows do not need an install or compile step. It is already exercised inside the repository through `uses: ./`. External projects should wait for the reviewed `v0.1.0` tag or pin a full reviewed commit SHA once the repository is public. The npm and Action snippets in the README are clearly marked as post-publish paths until those artifacts exist.

Ctxprof intentionally uses a small operational footprint: Node built-ins at runtime, append-only JSONL, and self-contained HTML reports. The release audit benchmark wrote and validated 3,000 deterministic runs totaling 16.46 MiB on Node 22 and 24, with full reads around 15,000 runs per second in that Docker Desktop environment. Those numbers are a reproducibility reference, not a promise for other hardware. The supported v0.1 bracket remains one writer and up to 3,000 captures or roughly 25 MiB; the [benchmark notes](BENCHMARKING.md) define when a SQLite adapter would deserve measurement.

Ctxprof is not a replacement for evaluation or full tracing platforms. It answers a narrower engineering question: which part of this context grew, what might it cost, and should this pull request be allowed to ship? If prompts are becoming code in your system, their size and composition deserve the same visible review loop as any other production artifact.

## Short post

LLM APIs give you a token total, but not a useful answer to “what grew?” Ctxprof is a local-first context-window profiler that breaks requests into system/developer prompts, tool schemas, messages, tool results, and response formats. It adds an interactive treemap, prompt-version A/B diffs, and a fail-closed CI budget for tokens, estimated cost, warnings, and individual components.

You can try the deterministic demo from source with no API key. Runtime code has zero third-party dependencies; offline analysis needs no network. The proxy binds to loopback by default, never stores ordinary headers, redacts common secrets, and offers preview-free `--capture none`. Those protections have documented limits, so synthetic fixtures remain the safest starting point.

The npm package and `v0.1.0` Action tag are staged but not published yet. Source instructions are in the README: <https://github.com/Dtdkvn/ctxprof>.

## Hacker News title

> Show HN: Ctxprof – a local flamegraph and CI budget for LLM context windows

## Launch checklist

### Repository and profile

- [ ] Create the public `Dtdkvn/ctxprof` repository; do not advertise the URL before it resolves.
- [ ] Configure `origin`, push the reviewed `main` history, and confirm the working tree and remote tip match.
- [ ] Set the About text above and add the listed topics.
- [ ] Confirm GitHub renders the logo, dashboard image, Mermaid diagram, license, security policy, contributing guide, and code of conduct.
- [ ] Enable private vulnerability reporting and review branch protection for required CI checks.
- [ ] Verify every package URL, changelog comparison link, Action example, and social link uses `Dtdkvn/ctxprof`.

### Release readiness

- [ ] Run `npm ci --ignore-scripts --no-audit --no-fund` on Node 22 and Node 24.
- [ ] Run `npm run check`, `npm run smoke`, `npm run smoke:action`, `npm run smoke:package`, `npm audit --audit-level=high`, and `npm pack --dry-run` on the release commit.
- [ ] Build the container, run its health check as the non-root `node` user with a read-only filesystem, and run `node scripts/check-image-layers.mjs <image>`.
- [ ] Confirm the deterministic demo contains no credentials, private data, personal filesystem paths, or external network dependency.
- [ ] Confirm the `ctxprof` package name is available immediately before configuring npm publishing.
- [ ] Create the GitHub `release` environment and configure npm trusted publishing for repository `Dtdkvn/ctxprof`, workflow filename `release.yml`, environment `release`, and `npm publish`; do not add a long-lived npm token.
- [ ] Wait for CI on `main` to pass before creating the release tag.

### Publish and verify

- [ ] Create and push `v0.1.0` only from the reviewed `main` commit; the release workflow requires the tag to match `package.json` exactly.
- [ ] Wait for the release workflow to verify the tarball, publish with provenance, and create the GitHub release.
- [ ] On Node 22 or 24, verify `npm view ctxprof@0.1.0`, install the package in a clean temporary project, run `ctxprof demo`, and open the generated dashboard.
- [ ] In a separate test repository, pin `Dtdkvn/ctxprof` to the reviewed full tag commit SHA and verify both passing and deliberately failing budget annotations.
- [ ] Replace the README's “not published yet” language with current npm and Action instructions only after both artifacts resolve publicly.
- [ ] Publish the launch article and short post only after the repository, release, package, documentation links, and Action smoke all pass from a clean machine.
