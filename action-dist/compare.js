const COMPONENT_KINDS = [
    "system",
    "developer",
    "tools",
    "message",
    "tool_result",
    "other",
];
export function summarizeVersion(runs, version) {
    const selected = runs.filter((run) => run.promptVersion === version);
    if (selected.length === 0)
        throw new Error(`No captures found for prompt version “${version}”.`);
    const priced = selected.filter((run) => run.totals.estimatedTotalCostUsd !== null);
    const components = emptyComponents();
    for (const run of selected) {
        for (const component of run.components) {
            components[component.kind] += component.allocatedInputTokens;
        }
    }
    for (const kind of COMPONENT_KINDS)
        components[kind] = round(components[kind] / selected.length);
    return {
        version,
        runCount: selected.length,
        averageInputTokens: round(selected.reduce((sum, run) => sum + (run.totals.providerInputTokens ?? run.totals.estimatedInputTokens), 0) /
            selected.length),
        averageTotalTokens: round(selected.reduce((sum, run) => sum + run.totals.totalTokens, 0) / selected.length),
        averageCostUsd: priced.length === selected.length
            ? round(priced.reduce((sum, run) => sum + (run.totals.estimatedTotalCostUsd ?? 0), 0) /
                priced.length, 9)
            : null,
        averageWarnings: round(selected.reduce((sum, run) => sum + run.warnings.length, 0) / selected.length, 2),
        components,
    };
}
export function compareVersions(runs, fromVersion, toVersion) {
    const from = summarizeVersion(runs, fromVersion);
    const to = summarizeVersion(runs, toVersion);
    const componentDelta = emptyComponents();
    for (const kind of COMPONENT_KINDS)
        componentDelta[kind] = to.components[kind] - from.components[kind];
    return {
        from,
        to,
        delta: {
            inputTokens: to.averageInputTokens - from.averageInputTokens,
            inputTokensPercent: percentage(from.averageInputTokens, to.averageInputTokens),
            totalTokens: to.averageTotalTokens - from.averageTotalTokens,
            costUsd: from.averageCostUsd === null || to.averageCostUsd === null
                ? null
                : round(to.averageCostUsd - from.averageCostUsd, 9),
            costPercent: from.averageCostUsd === null || to.averageCostUsd === null
                ? null
                : percentage(from.averageCostUsd, to.averageCostUsd),
            components: componentDelta,
        },
    };
}
export function versionsIn(runs) {
    return [...new Set(runs.map((run) => run.promptVersion))].sort();
}
function emptyComponents() {
    return {
        system: 0,
        developer: 0,
        tools: 0,
        message: 0,
        tool_result: 0,
        other: 0,
    };
}
function percentage(from, to) {
    if (from === 0)
        return to === 0 ? 0 : null;
    return round(((to - from) / from) * 100, 2);
}
function round(value, places = 0) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}
//# sourceMappingURL=compare.js.map