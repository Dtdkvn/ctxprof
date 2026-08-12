# Changelog

All notable changes will be documented here. Ctxprof follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Redacted credentials that appear as a JSON property name. Only values were scanned before, so a payload keyed by an API key or a JWT persisted that key verbatim in the local store.

### Roadmap

- Pluggable exact tokenizers without making the safe offline core dependent on native modules.
- Explicit cached-token and cache-write cost attribution when providers return sufficient metadata.
- SQLite store adapter with retention policies for larger local capture sets.
- Anthropic native Messages and Google Gemini native import adapters; proxy mode remains OpenAI-compatible first.
- Signed, reproducible standalone report artifacts.

## [0.1.0] - 2026-08-12

### Added

- OpenAI-compatible Chat Completions and Responses proxy with JSON/SSE pass-through, strict Host/Origin boundaries, a positive upstream-header allowlist, raw encoding preservation, abort propagation, deadlines, bounded request/stream accounting, and an ETag-conditional summary dashboard with lazy run details.
- Local interactive treemap, component details, cost insights, and explainable waste warnings.
- JSON, JSONL, HAR, OpenAI Batch, and normalized-run imports with strict metadata/schema validation, explicit overrides, safe repricing, interrupted-final-record recovery before append, and per-kind high-cardinality aggregation before detail allocation.
- Prompt-version A/B aggregation and CLI diff.
- Fail-closed context budget test with absolute limits, required committed baselines for regressions, nonempty per-file coverage, stable path-qualified collision identities, exit codes, and GitHub annotations.
- Structure-aware secret redaction, preview-free metadata-only capture, a bounded append-only JSONL store, and loopback-only default.
- Dated exact-match OpenAI standard text pricing plus validated custom provider catalogs whose supported rates always produce finite costs.
- Deterministic no-key demo, fixture suite, mock-upstream integration tests, hardened non-root Docker/Compose, and an offline prebuilt Node 24 GitHub Action.
- Maintained Node.js 22/24 support, complete CLI help and npm tarball assets, SHA-pinned CI, trusted publishing, and verified release provenance.

[Unreleased]: https://github.com/yewud/ctxprof/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yewud/ctxprof/releases/tag/v0.1.0
