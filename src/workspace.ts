import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface WorkspaceScope {
  root: string;
}

export interface WorkspaceFile {
  path: string;
  contents: string;
  modifiedAt: string;
}

export async function createWorkspaceScope(workspace: string): Promise<WorkspaceScope> {
  let root: string;
  try {
    root = await realpath(path.resolve(workspace));
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("GITHUB_WORKSPACE must resolve to an existing directory.");
  }
  return { root };
}

export async function readWorkspaceFile(
  scope: WorkspaceScope,
  value: string,
  baseDirectory: string,
  label: string,
): Promise<WorkspaceFile> {
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be a relative path inside GITHUB_WORKSPACE.`);
  }
  const lexicalPath = path.resolve(baseDirectory, value);
  if (!isInsideDirectory(scope.root, lexicalPath)) {
    throw new Error(`${label} escapes GITHUB_WORKSPACE.`);
  }

  let handle;
  try {
    handle = await open(lexicalPath, "r");
  } catch {
    throw new Error(`${label} not found inside GITHUB_WORKSPACE.`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) {
      throw new Error(`${label} must resolve to a regular file inside GITHUB_WORKSPACE.`);
    }

    let canonicalPath: string;
    let current: BigIntStats;
    try {
      canonicalPath = await realpath(lexicalPath);
      current = await stat(canonicalPath, { bigint: true });
    } catch {
      throw new Error(`${label} changed while it was being opened.`);
    }
    if (!isInsideDirectory(scope.root, canonicalPath)) {
      throw new Error(`${label} escapes GITHUB_WORKSPACE through a symbolic link.`);
    }
    if (!current.isFile()) {
      throw new Error(`${label} must resolve to a regular file inside GITHUB_WORKSPACE.`);
    }
    if (!sameFile(opened, current)) {
      throw new Error(`${label} changed while it was being opened.`);
    }

    const contents = await handle.readFile("utf8");
    const afterRead = await handle.stat({ bigint: true });
    if (!sameFile(opened, afterRead) || fileChanged(opened, afterRead)) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return {
      path: canonicalPath,
      contents,
      modifiedAt: new Date(Number(afterRead.mtimeMs)).toISOString(),
    };
  } finally {
    await handle.close();
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileChanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.size !== right.size || left.mtimeNs !== right.mtimeNs || left.ctimeNs !== right.ctimeNs;
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
