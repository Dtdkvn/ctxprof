import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const checker = path.resolve("scripts/check-image-layers.mjs");

test("image layer inspection streams listings larger than the child-process buffer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-layer-listing-"));
  try {
    const layerDirectory = path.join(directory, "large");
    await mkdir(layerDirectory);
    const entries = Array.from({ length: 14_000 }, (_, index) =>
      `app/dist/${String(index).padStart(5, "0")}-${"a".repeat(70)}.js`);
    entries.push("app/dist/leaked.js.map");
    assert.ok(entries.reduce((size, entry) => size + Buffer.byteLength(entry) + 1, 0) > 1_048_576);
    await writeTar(path.join(layerDirectory, "layer.tar"), entries);
    await writeClassicManifest(directory, ["large/layer.tar"]);

    const result = runChecker(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Development artifacts occur in image layers/);
    assert.match(result.stderr, /app\/dist\/leaked\.js\.map/);
    assert.doesNotMatch(result.stderr, /ENOBUFS|maxBuffer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image layer inspection fails closed when a declared layer cannot be listed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ctxprof-layer-corrupt-"));
  try {
    const layerDirectory = path.join(directory, "broken");
    await mkdir(layerDirectory);
    await writeFile(path.join(layerDirectory, "layer.tar"), "not a tar archive", "utf8");
    await writeClassicManifest(directory, ["broken/layer.tar"]);

    const result = runChecker(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not inspect declared image layer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runChecker(directory: string) {
  const result = spawnSync(process.execPath, [checker, "--saved-directory", directory], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

async function writeClassicManifest(directory: string, layers: string[]): Promise<void> {
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify([{ Config: "config.json", RepoTags: ["fixture:test"], Layers: layers }])}\n`,
    "utf8",
  );
}

async function writeTar(file: string, entries: string[]): Promise<void> {
  const blocks = entries.map((entry) => tarHeader(entry));
  blocks.push(Buffer.alloc(1_024));
  await writeFile(file, Buffer.concat(blocks));
}

function tarHeader(name: string): Buffer {
  assert.ok(Buffer.byteLength(name) <= 100, `Tar fixture path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, 0, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
