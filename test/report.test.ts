import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDemoRuns } from "../src/demo.js";
import { writeHtmlReport } from "../src/report.js";
import { renderDashboard } from "../src/ui/dashboard.js";

test("exports a self-contained interactive report", async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-report-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runs = createDemoRuns();
  runs[0]!.label = "</script><script>globalThis.ctxprofInjected=true</script>";
  const output = await writeHtmlReport(runs, path.join(directory, "report.html"));
  const html = await readFile(output, "utf8");
  assert.match(html, /support-v1/);
  assert.match(html, /support-v2/);
  assert.match(html, /Context treemap/);
  assert.doesNotMatch(html, /internal_facility_code/);
  assert.doesNotMatch(html, /<script>globalThis\.ctxprofInjected/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=["']https:/i);
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'none'/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("live dashboards poll sequentially and render newly captured runs without reload", async () => {
  const demo = createDemoRuns();
  const summary = (run: (typeof demo)[number]) => ({
    id: run.id,
    capturedAt: run.capturedAt,
    endpoint: run.endpoint,
    status: run.status,
    model: run.model,
    label: run.label,
    promptVersion: run.promptVersion,
    source: run.source,
    totals: run.totals,
  });
  const html = renderDashboard([], { mode: "proxy", generatedAt: "2026-08-12T00:00:00.000Z" });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);

  const elements = new Map<string, { innerHTML: string; value: string; addEventListener: () => void }>();
  const getElement = (id: string) => {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = { innerHTML: "", value: "", addEventListener: () => undefined };
    elements.set(id, created);
    return created;
  };
  const visibilityListeners: Array<() => void> = [];
  const documentStub = {
    hidden: false,
    getElementById: getElement,
    querySelectorAll: () => [],
    addEventListener: (name: string, listener: () => void) => {
      if (name === "visibilitychange") visibilityListeners.push(listener);
    },
  };
  const timers: Array<() => void> = [];
  let clearedTimers = 0;
  let feedCount = 0;
  let detailCount = 0;
  const feedHeaders: Array<string | undefined> = [];
  const fetchStub = async (url: string, init?: { headers?: Record<string, string> }) => {
    if (url.startsWith("/api/runs/")) {
      detailCount += 1;
      const id = decodeURIComponent(url.slice("/api/runs/".length));
      const run = demo.find((candidate) => candidate.id === id);
      assert.ok(run);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => run,
      };
    }
    feedCount += 1;
    feedHeaders.push(init?.headers?.["If-None-Match"]);
    if (feedCount === 3) {
      return {
        ok: false,
        status: 304,
        headers: { get: () => '"feed-v2"' },
        json: async () => { throw new Error("304 responses have no body"); },
      };
    }
    const etag = feedCount === 1 ? '"feed-v1"' : '"feed-v2"';
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === "etag" ? etag : null },
      json: async () => ({ runs: feedCount === 1 ? [summary(demo[0]!)] : [summary(demo[1]!), summary(demo[0]!)] }),
    };
  };
  const setTimeoutStub = (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  };
  const clearTimeoutStub = () => { clearedTimers += 1; };

  new Function("document", "fetch", "setTimeout", "clearTimeout", script)(
    documentStub,
    fetchStub,
    setTimeoutStub,
    clearTimeoutStub,
  );
  await flushPromises();
  assert.match(getElement("run-list").innerHTML, /Support agent · verbose/);
  assert.match(getElement("app").innerHTML, /Proxy live/);
  assert.equal(feedCount, 1);
  assert.equal(detailCount, 1, "only the selected run loads its full profile");
  assert.equal(timers.length, 1);

  timers.shift()?.();
  await flushPromises();
  assert.match(getElement("run-list").innerHTML, /Support agent · lean/);
  assert.equal(feedCount, 2);
  assert.equal(detailCount, 1, "new summaries do not eagerly load full runs");
  assert.equal(feedHeaders[1], '"feed-v1"');
  assert.equal(timers.length, 1);

  timers.shift()?.();
  await flushPromises();
  assert.equal(feedCount, 3);
  assert.equal(feedHeaders[2], '"feed-v2"');
  assert.match(getElement("run-list").innerHTML, /Support agent · lean/);
  assert.equal(timers.length, 1);

  documentStub.hidden = true;
  visibilityListeners[0]?.();
  assert.equal(clearedTimers, 1, "hidden dashboards cancel their pending poll");
});

test("dashboard mode labels distinguish static, store, and proxy views", () => {
  const run = createDemoRuns()[0]!;
  for (const [mode, label] of [
    ["static", "Static report"],
    ["store", "Capture store live"],
    ["proxy", "Proxy live"],
  ] as const) {
    const html = renderDashboard([run], { mode });
    assert.match(html, new RegExp(`var MODE=${JSON.stringify(mode)}`));
    assert.match(html, new RegExp(label));
  }
});

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
