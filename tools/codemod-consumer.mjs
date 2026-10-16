import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { compileGuides } from "@topik/core";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@topik/codemod/package.json"));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const fixture = await mkdtemp(join(tmpdir(), "topik-installed-codemod-"));
try {
  await writeFile(join(fixture, "collection.yaml"), "id: docs\ntitle: Docs\n");
  await writeFile(join(fixture, "next.mdx"), "# Next\n");
  await writeFile(
    join(fixture, "start.mdx"),
    "# Start\n\n[Next](./next.mdx?view=full#next)\n[Trailing](./next.mdx/?view=full#next)\n[Encoded](./next.md%78%2f?view=full#next)\n",
  );
  await compileGuides({ dir: fixture });
  execFileSync(
    process.execPath,
    [join(packageRoot, manifest.bin["topik-codemod"]), "mintlify", fixture],
    { stdio: "pipe" },
  );
  const result = await compileGuides({ dir: fixture });
  assert.deepEqual(
    result.references.map((reference) => reference.href),
    ["./next.md?view=full#next", "./next.md/?view=full#next", "./next.md%2f?view=full#next"],
  );
  assert.ok(result.references.every((reference) => reference.status === "verified"));
  console.log("Verified installed codemod migration preserves compilable page links");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
