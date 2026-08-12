import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const FORBIDDEN_RUNTIME_ARTIFACT = /(?:^|\/)app\/dist\/.*(?:\.d\.ts|\.map)$/;
const FILESYSTEM_LAYER_MEDIA_TYPE = /(?:image\.layer\.v1\.tar|image\.rootfs\.diff\.tar)/;
const MAX_LAYER_ENTRY_CHARS = 1_048_576;
const MAX_ERROR_CHARS = 16_384;

export async function inspectImage(image) {
  assert.ok(image, "Usage: node scripts/check-image-layers.mjs <image>");
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-image-layers-"));
  try {
    const archive = path.join(directory, "image.tar");
    execFileSync("docker", ["save", "--output", archive, image], { stdio: "inherit" });
    execFileSync("tar", ["-xf", archive, "-C", directory], { stdio: "inherit" });
    return await inspectSavedImageDirectory(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function inspectSavedImageDirectory(directory) {
  const candidates = await collectDeclaredLayers(directory);
  assert.ok(candidates.length > 0, "No manifest-declared filesystem layers were found.");

  const forbidden = [];
  let forbiddenCount = 0;
  for (const candidate of candidates) {
    const result = await inspectLayerArchive(candidate);
    forbiddenCount += result.count;
    for (const entry of result.sample) {
      if (forbidden.length < 20) forbidden.push(`${path.basename(candidate)}:${entry}`);
    }
  }
  if (forbiddenCount > 0) {
    const remainder = forbiddenCount > forbidden.length
      ? `\n...and ${forbiddenCount - forbidden.length} more`
      : "";
    throw new Error(`Development artifacts occur in image layers:\n${forbidden.join("\n")}${remainder}`);
  }
  process.stdout.write(
    `Inspected ${candidates.length} manifest-declared image layers; no declarations or source maps found.\n`,
  );
  return candidates.length;
}

export async function inspectLayerArchive(candidate) {
  await assertRegularFile(candidate, "Declared image layer");
  return await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tf", candidate], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let remainder = "";
    let errorOutput = "";
    let failure;
    let forbiddenCount = 0;
    const forbidden = [];

    const inspectEntry = (entry) => {
      if (!FORBIDDEN_RUNTIME_ARTIFACT.test(entry)) return;
      forbiddenCount += 1;
      if (forbidden.length < 20) forbidden.push(entry);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      remainder += chunk;
      if (remainder.length > MAX_LAYER_ENTRY_CHARS && !remainder.includes("\n")) {
        failure = new Error(`Layer entry exceeds ${MAX_LAYER_ENTRY_CHARS} characters: ${candidate}`);
        child.kill();
        return;
      }
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) inspectEntry(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-MAX_ERROR_CHARS);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code, signal) => {
      if (!failure && remainder) inspectEntry(remainder);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 || signal) {
        reject(new Error(
          `Could not inspect declared image layer ${candidate}` +
          ` (exit=${String(code)}, signal=${String(signal)}): ${errorOutput.trim()}`,
        ));
        return;
      }
      resolve({ count: forbiddenCount, sample: forbidden });
    });
  });
}

async function collectDeclaredLayers(root) {
  const ociIndex = path.join(root, "index.json");
  if (await exists(ociIndex)) return await collectOciLayers(root, ociIndex);

  const classicManifest = path.join(root, "manifest.json");
  assert.ok(await exists(classicManifest), "Saved image has neither index.json nor manifest.json.");
  const manifest = await readJson(classicManifest);
  assert.ok(Array.isArray(manifest) && manifest.length > 0, "Classic image manifest is empty or invalid.");
  const layers = [];
  for (const image of manifest) {
    assert.ok(image && Array.isArray(image.Layers), "Classic image manifest has no Layers array.");
    for (const relative of image.Layers) {
      assert.equal(typeof relative, "string", "Classic image layer path must be a string.");
      layers.push(resolveContained(root, relative));
    }
  }
  return await uniqueRegularFiles(layers);
}

async function collectOciLayers(root, indexPath) {
  const index = await readJson(indexPath);
  assert.ok(index && Array.isArray(index.manifests), "OCI index has no manifests array.");
  const layers = [];
  let imageManifests = 0;
  const visited = new Set();

  async function visitDescriptor(descriptor) {
    assert.ok(descriptor && typeof descriptor.mediaType === "string", "OCI descriptor has no media type.");
    const target = blobPath(root, descriptor.digest);
    const identity = `${descriptor.mediaType}:${target}`;
    if (visited.has(identity)) return;
    visited.add(identity);

    if (descriptor.mediaType.includes("image.index")) {
      const nested = await readJson(target);
      assert.ok(nested && Array.isArray(nested.manifests), "OCI nested index has no manifests array.");
      for (const child of nested.manifests) await visitDescriptor(child);
      return;
    }

    assert.ok(descriptor.mediaType.includes("image.manifest"), `Unsupported OCI descriptor: ${descriptor.mediaType}`);
    const manifest = await readJson(target);
    assert.ok(manifest && Array.isArray(manifest.layers), "OCI image manifest has no layers array.");
    const filesystemLayers = manifest.layers.filter((layer) =>
      layer && typeof layer.mediaType === "string" && FILESYSTEM_LAYER_MEDIA_TYPE.test(layer.mediaType));
    const isAttestation = descriptor.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";
    if (filesystemLayers.length === 0 && isAttestation) return;
    assert.equal(
      filesystemLayers.length,
      manifest.layers.length,
      "OCI runnable image manifest contains an unsupported non-filesystem layer.",
    );
    imageManifests += 1;
    for (const layer of filesystemLayers) layers.push(blobPath(root, layer.digest));
  }

  for (const descriptor of index.manifests) await visitDescriptor(descriptor);
  assert.ok(imageManifests > 0, "OCI index contains no runnable image manifest.");
  return await uniqueRegularFiles(layers);
}

function blobPath(root, digest) {
  assert.equal(typeof digest, "string", "OCI descriptor digest must be a string.");
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  assert.ok(match, `Unsupported or malformed OCI digest: ${digest}`);
  return resolveContained(root, path.join("blobs", "sha256", match[1]));
}

function resolveContained(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const prefix = `${resolvedRoot}${path.sep}`;
  assert.ok(resolved.startsWith(prefix), `Manifest layer escapes saved-image directory: ${relative}`);
  return resolved;
}

async function uniqueRegularFiles(files) {
  const unique = [...new Set(files)];
  for (const file of unique) await assertRegularFile(file, "Manifest-declared layer");
  return unique;
}

async function assertRegularFile(file, label) {
  const details = await stat(file);
  assert.ok(details.isFile(), `${label} is not a regular file: ${file}`);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function main(args) {
  if (args[0] === "--saved-directory") {
    assert.ok(args[1] && args.length === 2, "Usage: --saved-directory <path>");
    await inspectSavedImageDirectory(path.resolve(args[1]));
    return;
  }
  assert.ok(args[0] && args.length === 1, "Usage: node scripts/check-image-layers.mjs <image>");
  await inspectImage(args[0]);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main(process.argv.slice(2));
