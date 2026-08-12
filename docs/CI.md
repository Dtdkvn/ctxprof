# Context budgets in CI

A context budget catches accidental prompt growth before it compounds across requests. It is intentionally separate from output-quality evaluation: run both.

## 1. Create representative inputs

Commit synthetic or approved sanitized JSON under an `evals/` directory. Each file may contain a raw request, a `{ request, response }` wrapper, JSONL cases, or a sanitized HAR. Provider usage in a fixture becomes the displayed total; component breakdowns remain deterministic estimates.

Every configured input must yield at least one supported case. Empty JSONL/arrays, empty or unsupported HAR files, and empty files mixed with valid fixtures fail the gate instead of silently reducing evaluation coverage.

Keep case paths stable. Baselines use a friendly basename when unique, a normalized config-relative path when basenames collide, and a `#N` suffix for multi-record files.

## 2. Configure limits

Copy the root [ctxprof.config.json](../ctxprof.config.json) and adjust:

- `limits` are hard ceilings independent of history;
- `regressions` compare each current case with the committed baseline;
- `components` use `system`, `developer`, `tools`, `message`, `tool_result`, and `other`;
- a configured cost check fails when pricing is unknown.

Paths in the config are resolved relative to the config file. When the GitHub Action runs, its config and optional pricing inputs must be relative paths, and every config, pricing, input, and baseline file must resolve to a regular file inside the canonical `GITHUB_WORKSPACE`; parent, absolute, and symbolic-link escapes fail closed. The standalone CLI intentionally keeps operator-selected paths unrestricted. The JSON Schema at [ctxprof-config.schema.json](ctxprof-config.schema.json) enables editor validation.

## 3. Establish the baseline

Until the first npm release is published, run these commands from a built source checkout as `node dist/cli.js check ...`. After publication, the package-based commands are:

```bash
npx ctxprof check --update-baseline
git add ctxprof.config.json .ctxprof-baseline.json
git commit -m "test: establish context budget"
```

Review baseline changes like lockfile or bundle-size changes. Updating a baseline should be an explicit decision, not the automatic response to a failing pull request. When regression rules are enabled, both newly added current cases and removed baseline cases fail until that case-set change is acknowledged with an update.

## 4. Run the gate

```bash
npx ctxprof check
```

Exit code `0` means every case passed. Exit code `1` means at least one hard limit, regression limit, missing case, or required price check failed. `--json` returns structured metrics and violations.

Baseline case IDs use the friendly basename when it is unique. If two inputs share a basename, Ctxprof uses a normalized config-directory-relative path (for example `prompts/a/case.json`) so reordering inputs cannot swap baseline identities; duplicate exact inputs are rejected.

For GitHub-hosted workflows, the Node 24 JavaScript Action in [examples/github-actions/context-budget.yml](../examples/github-actions/context-budget.yml) shows the post-release tag form. The checked-in Action is already exercised by this repository through `uses: ./`; before the documented tag exists, external consumers can pin a reviewed 40-character commit SHA. It runs its checked-in JavaScript without downloading dependencies, compiling, or depending on the caller's `node` executable. `--github` emits `::error` annotations if you invoke the CLI directly.

## Useful policies

### Tight stable prompt

```json
{
  "regressions": {
    "inputTokensPercent": 0,
    "componentPercent": 0,
    "warningsIncrease": 0
  }
}
```

### Early product with headroom

```json
{
  "limits": {
    "inputTokens": 12000,
    "components": {
      "tools": 5000,
      "tool_result": 4000
    }
  },
  "regressions": {
    "inputTokensPercent": 10,
    "componentPercent": 20
  }
}
```

### Cost-sensitive high volume

Use an exact pricing catalog checked against your provider contract, then set both cost and token limits. Token checks remain valuable because negotiated prices can change independently from context quality.

## Troubleshooting

- **A case disappeared:** keep the old fixture or intentionally regenerate the baseline after review. Missing baseline cases fail to prevent silent coverage loss.
- **A case was added:** inspect its absolute metrics, then regenerate the baseline. Regression mode requires every current case to have an explicit reference.
- **Cost is unknown:** add the exact model ID to a pricing catalog; do not rename it to a “similar” built-in model.
- **Provider total is stable but a component regressed:** this is expected and useful. Another component may have shrunk enough to hide the growth in the total.
- **Small estimate drift after upgrading Ctxprof:** review the release notes. Estimator changes are schema/behavior changes and should be called out.
