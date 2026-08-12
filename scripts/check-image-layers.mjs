import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const image = process.argv[2];
assert.ok(image, "Usage: node scripts/check-image-layers.mjs <image>");

const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-image-layers-"));
try {
  const archive = path.join(directory, "image.tar");
  execFileSync("docker", ["save", "--output", archive, image], { stdio: "inherit" });
  execFileSync("tar", ["-xf", archive, "-C", directory]);

  const blobs = path.join(directory, "blobs", "sha256");
  // Docker's OCI archive expands directly under `directory`; classic archives
  // instead expose `layer.tar` files. Support both formats for local and CI use.
  const candidates = await collectLayerCandidates(directory, blobs);
  const forbidden = [];
  let inspectedLayers = 0;
  for (const candidate of candidates) {
    const listing = spawnSync("tar", ["-tf", candidate], { encoding: "utf8" });
    if (listing.status !== 0) continue;
    inspectedLayers += 1;
    for (const entry of listing.stdout.split(/\r?\n/)) {
      if (/(?:^|\/)app\/dist\/.*(?:\.d\.ts|\.map)$/.test(entry)) {
        forbidden.push(`${path.basename(candidate)}:${entry}`);
      }
    }
  }
  assert.ok(inspectedLayers > 0, "No filesystem layers were found in the saved image.");
  if (forbidden.length > 0) {
    const sample = forbidden.slice(0, 20).join("\n");
    const remainder = forbidden.length > 20 ? `\n...and ${forbidden.length - 20} more` : "";
    throw new Error(`Development artifacts occur in image layers:\n${sample}${remainder}`);
  }
  process.stdout.write(`Inspected ${inspectedLayers} image layers; no declarations or source maps found.\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function collectLayerCandidates(root, ociBlobs) {
  try {
    return (await readdir(ociBlobs, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(ociBlobs, entry.name));
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const candidates = [];
  await visit(root, candidates);
  return candidates;
}

async function visit(directory, candidates) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(target, candidates);
    else if (entry.name === "layer.tar") candidates.push(target);
  }
}
