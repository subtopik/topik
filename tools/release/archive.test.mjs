import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveFilename, parseTar, resolveArtifactDirectory } from "./archive.mjs";

void test("archive naming accepts only the fixed public package set", () => {
  assert.equal(
    archiveFilename("@topik/content-schema", "0.1.0-alpha.5"),
    "topik-content-schema-0.1.0-alpha.5.tgz",
  );
  assert.throws(() => archiveFilename("@topik/astro", "0.1.0-alpha.5"), /unknown package/u);
  assert.throws(() => archiveFilename("--tag", "alpha"), /unknown package/u);
  assert.throws(() => archiveFilename("@topik/core", "../../unexpected"), /unsafe version/u);
});

void test("artifact paths reject traversal, pre-existing output, missing input, and links", async () => {
  const root = await mkdtemp(join(tmpdir(), "topik-release-paths-"));
  try {
    await assert.rejects(
      resolveArtifactDirectory(root, "../outside", { mustExist: false }),
      /safe workspace-relative/u,
    );
    await assert.rejects(
      resolveArtifactDirectory(root, "missing", { mustExist: true }),
      /missing or unsafe/u,
    );
    await mkdir(join(root, "existing"));
    await assert.rejects(
      resolveArtifactDirectory(root, "existing", { mustExist: false }),
      /already exists/u,
    );
    assert.equal(
      await resolveArtifactDirectory(root, "existing", { mustExist: true }),
      join(root, "existing"),
    );
    await symlink(join(root, "existing"), join(root, "linked"));
    await assert.rejects(
      resolveArtifactDirectory(root, "linked", { mustExist: true }),
      /missing or unsafe/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("tar parsing rejects duplicate paths and link or special entries", () => {
  assert.throws(
    () => parseTar(makeTar([{ path: "package/file", type: "2", bytes: Buffer.alloc(0) }])),
    /link or special file/u,
  );
  assert.throws(
    () =>
      parseTar(
        makeTar([
          { path: "package/file", type: "0", bytes: Buffer.from("one") },
          { path: "package/file", type: "0", bytes: Buffer.from("two") },
        ]),
      ),
    /duplicate entries/u,
  );
  assert.throws(
    () => parseTar(makeTar([{ path: "package/../escape", type: "0", bytes: Buffer.alloc(0) }])),
    /unsafe path/u,
  );
  const trailingData = makeTar([
    { path: "package/file", type: "0", bytes: Buffer.from("content") },
  ]);
  trailingData[trailingData.length - 1] = 1;
  assert.throws(() => parseTar(trailingData), /data after its terminator/u);
});

function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(`${checksumText}\0 `, 148, 8, "ascii");
    blocks.push(header, entry.bytes);
    const padding = (512 - (entry.bytes.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeOctal(buffer, offset, length, value) {
  buffer.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}
