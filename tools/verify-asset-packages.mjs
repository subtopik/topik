import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const schemaRoot = join(root, "packages", "schema");
const coreRoot = join(root, "packages", "core");
const contentSchemaRoot = join(root, "packages", "content-schema");
const contentReactRoot = join(root, "packages", "content-react");
const generatedNamePattern = "^auto-v1-[a-z2-7]{51}[aq]$";

const sourceSchema = readFileSync(join(schemaRoot, "src", "asset-v1.json"));
const builtSchema = readFileSync(join(schemaRoot, "dist", "asset-v1.json"));
if (!sourceSchema.equals(builtSchema))
  throw new Error("Asset/v1 source and packaged schemas differ");
if (JSON.parse(sourceSchema).properties?.name?.pattern !== generatedNamePattern) {
  throw new Error("Asset/v1 generated-name grammar is not canonical");
}

for (const directory of [schemaRoot, coreRoot, contentSchemaRoot]) {
  const builtFiles = readdirSync(join(directory, "dist")).filter(
    (file) => file.endsWith(".mjs") || file.endsWith(".d.mts"),
  );
  const builtText = builtFiles
    .map((file) => readFileSync(join(directory, "dist", file), "utf8"))
    .join("\n");
  if (!builtText.includes("[a-z2-7]{51}[aq]")) {
    throw new Error(`Canonical generated-name grammar is missing from ${directory} output`);
  }
}

const contentReactOutput = readdirSync(join(contentReactRoot, "dist"))
  .filter((file) => file.endsWith(".mjs") || file.endsWith(".d.mts"))
  .map((file) => readFileSync(join(contentReactRoot, "dist", file), "utf8"))
  .join("\n");
if (
  !contentReactOutput.includes("TOPIK_GENERATED_ASSET_NAME_PATTERN") ||
  !contentReactOutput.includes("TopikGeneratedAssetName")
) {
  throw new Error("Content renderer package does not preserve canonical generated-name boundaries");
}

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
