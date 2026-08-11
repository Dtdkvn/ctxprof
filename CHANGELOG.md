# Changelog

All notable changes will be documented here. Ctxprof follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Roadmap

- Pluggable exact tokenizers without making the safe offline core dependent on native modules.
- Explicit cached-token and cache-write cost attribution when providers return sufficient metadata.
- SQLite store adapter with retention policies for larger local capture sets.
- Anthropic native Messages and Google Gemini native import adapters; proxy mode remains OpenAI-compatible first.
- Signed, reproducible standalone report artifacts.

## [0.1.0] - 2026-08-11

### Added

- OpenAI-compatible Chat Completions and Responses proxy with JSON and SSE pass-through.
- Local interactive treemap, component details, cost insights, and explainable waste warnings.
- JSON, JSONL, HAR, OpenAI Batch, and normalized-run import workflows.
- Prompt-version A/B aggregation and CLI diff.
- Context budget test with absolute limits, committed baselines, component regressions, exit codes, and GitHub annotations.
- Redacted or metadata-only capture, bounded append-only JSONL store, and loopback-only default.
- Dated exact-match OpenAI standard text pricing plus custom provider catalogs.
- Deterministic no-key demo, fixture suite, mock upstream integration test, Docker/Compose, and composite GitHub Action.
