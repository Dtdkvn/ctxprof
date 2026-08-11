import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfileRun } from "./types.js";
import { renderDashboard } from "./ui/dashboard.js";

export async function writeHtmlReport(
  runs: readonly ProfileRun[],
  outputPath: string,
  title = "Ctxprof context report",
): Promise<string> {
  const absolute = path.resolve(outputPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  // The dashboard never reads raw exchanges. Leave them out of portable HTML
  // so sharing a report does not duplicate a full redacted traffic archive.
  const reportRuns = runs.map((run) => ({
    ...run,
    exchange: {
      request: null,
      response: null,
      captureMode: run.exchange.captureMode,
      truncated: run.exchange.truncated,
    },
  }));
  const html = renderDashboard(reportRuns, { live: false, title });
  await writeFile(absolute, html, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(absolute, 0o600);
  } catch {
    // POSIX permissions are best effort on Windows and mounted filesystems.
  }
  return absolute;
}
