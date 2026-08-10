import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const schemaRoot = join(root, "packages", "schema");
const coreRoot = join(root, "packages", "core");

const sourceSchema = readFileSync(join(schemaRoot, "src", "asset-v1.json"));
const builtSchema = readFileSync(join(schemaRoot, "dist", "asset-v1.json"));
if (!sourceSchema.equals(builtSchema))
  throw new Error("Asset/v1 source and packaged schemas differ");

const schemaPackage = JSON.parse(readFileSync(join(schemaRoot, "package.json"), "utf8"));
if (schemaPackage.exports?.["./asset/v1.json"] !== "./dist/asset-v1.json") {
  throw new Error("Asset/v1 schema export is missing or incorrect");
}

const expected = new Map([
  [
    schemaRoot,
    ["LICENSE", "dist/asset-v1.json", "dist/index.d.mts", "dist/index.mjs", "package.json"],
  ],
  [coreRoot, ["LICENSE", "dist/index.d.mts", "dist/index.mjs", "package.json"]],
]);

for (const [directory, expectedFiles] of expected) {
  const output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: directory,
    encoding: "utf8",
  });
  const pack = JSON.parse(output);
  const files = pack.files.map((entry) => entry.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Unexpected package files for ${pack.name}: ${files.join(", ")}`);
  }
}

console.log("Asset package exports, packlists, and schema parity verified");
