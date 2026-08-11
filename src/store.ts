import { appendFile, chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProfileRun } from "./types.js";

export class RunStore {
  readonly directory: string;
  readonly runsFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory = ".ctxprof") {
    this.directory = path.resolve(directory);
    this.runsFile = path.join(this.directory, "runs.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await bestEffortChmod(this.directory, 0o700);
  }

  async append(run: ProfileRun): Promise<void> {
    await this.init();
    await this.enqueue(async () => {
      await appendFile(this.runsFile, `${JSON.stringify(run)}\n`, { encoding: "utf8", mode: 0o600 });
      await bestEffortChmod(this.runsFile, 0o600);
    });
  }

  async appendMany(runs: readonly ProfileRun[]): Promise<void> {
    if (runs.length === 0) return;
    await this.init();
    const payload = runs.map((run) => JSON.stringify(run)).join("\n") + "\n";
    await this.enqueue(async () => {
      await appendFile(this.runsFile, payload, { encoding: "utf8", mode: 0o600 });
      await bestEffortChmod(this.runsFile, 0o600);
    });
  }

  async list(limit = 1_000): Promise<ProfileRun[]> {
    await this.writeQueue;
    let contents: string;
    try {
      contents = await readFile(this.runsFile, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const runs: ProfileRun[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isProfileRun(value)) runs.push(value);
      } catch {
        // A process may have stopped during the last append. JSONL recovery is
        // deliberately tolerant; valid preceding records remain usable.
      }
    }
    return runs.slice(-Math.max(0, limit)).reverse();
  }

  async sizeBytes(): Promise<number> {
    try {
      return (await stat(this.runsFile)).size;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.writeQueue.then(operation, operation);
    // Keep the internal queue usable after a failed write while returning the
    // original failure to the caller that attempted it.
    this.writeQueue = current.catch(() => undefined);
    await current;
  }
}

export function isProfileRun(value: unknown): value is ProfileRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    run.schemaVersion === 1 &&
    typeof run.id === "string" &&
    typeof run.model === "string" &&
    Array.isArray(run.components) &&
    Boolean(run.totals)
  );
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs and some mounted filesystems do not expose POSIX modes.
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}
