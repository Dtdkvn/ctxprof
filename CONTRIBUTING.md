# Contributing to Ctxprof

Thank you for helping make LLM context visible and affordable. Small, focused changes with deterministic fixtures are easiest to review.

## Set up

Requirements: Node.js 20 or 22 and npm 10+.

```bash
git clone <your-fork-url>
cd ctxprof
npm ci
npm run check
```

Run the no-key demo with `npm run demo`, or use `npm run dev -- proxy` for TypeScript watch-time execution.

## Before opening a pull request

```bash
npm run check
npm run smoke
```

The check runs repository lint, strict TypeScript checking, 14+ unit/integration tests, and the production build. The smoke test exercises the built CLI, HTML report, A/B comparison, and this repository's own context budget.

Please also:

- add or update a deterministic fixture for parsing/profiling behavior;
- avoid real prompts, user data, credentials, HAR headers, and vendor response IDs;
- document user-visible flags or schema changes;
- keep runtime dependencies at zero unless a dependency has a clear security and maintenance case;
- include an official provider URL and `checkedAt` date for pricing changes;
- use Conventional Commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, and `chore:`.

## Design principles

1. **Honest estimates.** Unknown must remain unknown. Never silently substitute pricing or claim estimated component counts are provider-exact.
2. **Privacy before convenience.** No headers in records, no full-capture escape hatch, bounded storage, and loopback by default.
3. **Explainable advice.** A warning should cite the measurable condition and describe a reversible experiment. Ctxprof does not auto-delete context.
4. **Portable evidence.** Core analysis must work on deterministic files without a live key or network.
5. **Boring operations.** Node built-ins, JSONL, self-contained reports, and clear failure output beat infrastructure that a local profiler does not need.

## Adding an importer

Importers should turn external data into `{ request, response, endpoint, status, durationMs, capturedAt }` without copying headers. Invalid unrelated records may be skipped only when the container format can contain other traffic (for example, a HAR). Malformed files explicitly passed by a user should produce a clear error.

## Adding a warning

Warnings need:

- a stable code and severity;
- a deterministic threshold or comparison;
- a short title and an actionable, non-prescriptive explanation;
- tests for trigger and non-trigger cases;
- an estimated waste count only when the attribution is defensible.

## Pull request scope

Open an issue before a large protocol, persistence, or UI rewrite. Security fixes should follow [SECURITY.md](SECURITY.md), not a public issue. By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
