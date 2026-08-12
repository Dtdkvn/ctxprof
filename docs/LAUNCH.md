# Ctxprof launch kit

The source repository, [`ctxprof@0.1.0`](https://www.npmjs.com/package/ctxprof), [`v0.1.0` Action tag](https://github.com/Dtdkvn/ctxprof/tree/v0.1.0), and [GitHub release](https://github.com/Dtdkvn/ctxprof/releases/tag/v0.1.0) are public. This file preserves the reviewed launch copy and evidence checklist for future releases.

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

You can start without an API key. Install `ctxprof` from npm, then run `ctxprof demo` and `ctxprof serve`; the deterministic demo includes a deliberately bloated support prompt and a leaner revision. A source checkout can also analyze JSON, JSONL, OpenAI Batch records, or sanitized HAR files without sending them to a hosted service.

For live traffic, Ctxprof can sit in front of an OpenAI-compatible Chat Completions or Responses API endpoint. Change the SDK base URL and keep the rest of the request flow intact. The proxy forwards JSON and streaming responses, then profiles a bounded copy. It listens on loopback by default, follows no redirects, and forwards only an explicit header allowlist unless the operator opts in to another provider header.

Privacy is a boundary, not a slogan. Ordinary request and response headers are never stored. Common credential formats and semantic secret fields are redacted before persistence, stored exchanges are capped, and `--capture none` removes bodies and previews while retaining metrics and hashes. The dashboard stays local and unauthenticated, so it must not be exposed directly to an untrusted network. Pattern redaction also cannot find every private fact; sensitive teams should prefer synthetic fixtures and encrypted local storage. The full limits are documented in the [privacy guide](PRIVACY.md) and [security policy](../SECURITY.md).

The other half of Ctxprof is change control. Give captures stable prompt-version labels and compare aggregate A-to-B token, cost, component, and warning deltas. Commit a baseline with representative fixtures, define absolute and regression limits, and run `ctxprof check` in CI. A failed budget identifies the cases and components that crossed the line instead of reducing the result to a generic token-count failure.

The GitHub Action is prebuilt JavaScript for the Node 24 Action runtime, so caller workflows do not need an install or compile step. It is exercised inside the repository through `uses: ./`; external projects can use `Dtdkvn/ctxprof@v0.1.0` or pin the tag's full reviewed commit SHA.

Ctxprof intentionally uses a small operational footprint: Node built-ins at runtime, append-only JSONL, and self-contained HTML reports. The release audit benchmark wrote and validated 3,000 deterministic runs totaling 16.46 MiB on Node 22 and 24, with full reads around 15,000 runs per second in that Docker Desktop environment. Those numbers are a reproducibility reference, not a promise for other hardware. The supported v0.1 bracket remains one writer and up to 3,000 captures or roughly 25 MiB; the [benchmark notes](BENCHMARKING.md) define when a SQLite adapter would deserve measurement.

Ctxprof is not a replacement for evaluation or full tracing platforms. It answers a narrower engineering question: which part of this context grew, what might it cost, and should this pull request be allowed to ship? If prompts are becoming code in your system, their size and composition deserve the same visible review loop as any other production artifact.

## Short post

LLM APIs give you a token total, but not a useful answer to “what grew?” Ctxprof is a local-first context-window profiler that breaks requests into system/developer prompts, tool schemas, messages, tool results, and response formats. It adds an interactive treemap, prompt-version A/B diffs, and a fail-closed CI budget for tokens, estimated cost, warnings, and individual components.

You can try the deterministic demo from source with no API key. Runtime code has zero third-party dependencies; offline analysis needs no network. The proxy binds to loopback by default, never stores ordinary headers, redacts common secrets, and offers preview-free `--capture none`. Those protections have documented limits, so synthetic fixtures remain the safest starting point.

The source, npm package, provenance, `v0.1.0` Action tag, and GitHub release are live at the links above.

## Hacker News title

> Show HN: Ctxprof – a local flamegraph and CI budget for LLM context windows

## Launch checklist

### Repository and profile

- [x] Publish the public `Dtdkvn/ctxprof` source repository.
- [x] Publish the reviewed `main` history before starting the package release sequence.
- [x] Set the About text above and add the listed topics.
- [x] Confirm GitHub renders the logo, dashboard image, Mermaid diagram, license, security policy, contributing guide, and code of conduct.
- [x] Enable private vulnerability reporting and review branch protection.
- [x] Verify every package URL, changelog comparison link, Action example, and social link uses `Dtdkvn/ctxprof`.

### Release readiness

- [x] Run `npm ci --ignore-scripts --no-audit --no-fund` on Node 22 and Node 24.
- [x] Run `npm run check`, `npm run smoke`, `npm run smoke:action`, `npm run smoke:package`, `npm audit --audit-level=high`, and `npm pack --dry-run` on the release commit.
- [x] Build the container, run its health check as the non-root `node` user with a read-only filesystem, and run `node scripts/check-image-layers.mjs <image>`.
- [x] Confirm the deterministic demo contains no credentials, private data, personal filesystem paths, or external network dependency.
- [x] Confirm the `ctxprof` package name is available immediately before configuring npm publishing.
- [x] Use a seven-day granular token only for the first publish; never use a long-lived or classic token for this bootstrap.
- [x] Wait for CI on `main` to pass before creating the release tag.

### Publish and verify

- [x] Create and push `v0.1.0` only from the reviewed `main` commit; the release workflow requires the tag to match `package.json` exactly.
- [x] Wait for the release workflow to verify the tarball, publish with provenance, and create the GitHub release.
- [ ] Register npm trusted publishing for repository `Dtdkvn/ctxprof`, workflow `release.yml`, environment `release`, and `npm publish` after the npm account completes its required 2FA setup. The bootstrap `NPM_TOKEN` and workflow fallback have already been removed, so new-version publication fails closed until this connection exists.
- [x] On Node 24, verify `npm view ctxprof@0.1.0`, install the package in a clean temporary project, and run the packaged CLI plus ESM import smoke.
- [ ] In a separate test repository, pin `Dtdkvn/ctxprof` to the reviewed full tag commit SHA and verify both passing and deliberately failing budget annotations.
- [x] Replace the README's pre-release language with current npm and Action instructions only after both artifacts resolve publicly.
- [ ] Publish the launch article and short post only after the repository, release, package, documentation links, and Action smoke all pass from a clean machine.
