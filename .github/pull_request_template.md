## What changed

Describe the user-visible outcome and the smallest reason this change is needed.

## How it was verified

List the exact commands, fixtures, Node versions, Action run, or container checks used. Include a safe failure-path test when behavior is fail-closed.

## Privacy and compatibility

- [ ] Tests and examples contain only synthetic data. No real prompts, model output, credentials, tokens, HAR headers, customer identifiers, or personal paths are included.
- [ ] `redacted` and `none` capture behavior was considered where this change touches analysis, import, proxying, reports, or storage.
- [ ] Provider request/response pass-through and header boundaries were tested where proxy behavior changed.
- [ ] CI budget and baseline semantics were tested where metrics, warnings, pricing, case identity, or configuration changed.
- [ ] User-visible CLI flags, schemas, package exports, Action inputs, and documentation are updated where applicable.

## Checklist

- [ ] `npm run check`
- [ ] `npm run smoke`
- [ ] `npm run build:action` was run after runtime-source changes, and the generated diff was reviewed.
- [ ] No package version, release tag, generated baseline, or pricing snapshot changed unintentionally.
- [ ] No security-sensitive finding is disclosed here; any such finding is being coordinated privately.
