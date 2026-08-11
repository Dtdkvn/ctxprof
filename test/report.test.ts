import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDemoRuns } from "../src/demo.js";
import { writeHtmlReport } from "../src/report.js";

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
