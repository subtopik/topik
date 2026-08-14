import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverSchemaTargets } from "../packages/schema/scripts/schema-targets.mjs";

const root = join(import.meta.dirname, "..");
const schemaRoot = join(root, "packages", "schema");
const coreRoot = join(root, "packages", "core");
const contentSchemaRoot = join(root, "packages", "content-schema");
const contentReactRoot = join(root, "packages", "content-react");
const resourceNamePattern = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const schemaTargets = await discoverSchemaTargets(schemaRoot);
const typeFixtureRoot = join(root, "tools", "type-fixtures");

for (const target of schemaTargets) {
  const { resource, version } = target;
  const source = readFileSync(join(schemaRoot, target.schema));
  const built = readFileSync(join(schemaRoot, "dist", resource, `${version}.json`));
  if (!source.equals(built)) {
    throw new Error(`${resource}/${version} source and packaged schemas differ`);
  }
  if (JSON.parse(source).$id !== `https://topik.dev/schemas/${resource}/${version}.json`) {
    throw new Error(`${resource}/${version} schema identifier is not canonical`);
  }
  const schemaRuntime = await import(
    pathToFileURL(join(schemaRoot, "dist", resource, `${version}.mjs`))
  );
  if (Object.keys(schemaRuntime).length !== 0) {
    throw new Error(`${resource}/${version} unexpectedly exposes a runtime API`);
  }
}

const sourceSchema = readFileSync(join(schemaRoot, "src", "asset", "v1.json"));
const parsedSourceSchema = JSON.parse(sourceSchema);
if (parsedSourceSchema.properties?.name?.pattern !== resourceNamePattern) {
  throw new Error("Asset/v1 resource-name grammar is not canonical");
}
const assetSpecSchema = resolveLocalSchemaReference(
  parsedSourceSchema,
  parsedSourceSchema.properties?.spec,
);
if (
  assetSpecSchema.properties?.uri?.type !== "string" ||
  assetSpecSchema.properties?.uri?.pattern !== undefined
) {
  throw new Error("Asset/v1 URI is not an unrestricted string");
}

const contentSchemaRuntime = await import(
  pathToFileURL(join(contentSchemaRoot, "dist", "index.mjs"))
);
const coreRuntime = await import(pathToFileURL(join(coreRoot, "dist", "index.mjs")));
verifyGeneratedNameRuntime("content-schema", (name) =>
  contentSchemaRuntime.isTopikGeneratedAssetName(name),
);
verifyGeneratedNameRuntime("core", (name) => coreRuntime.isGeneratedAssetName(name));
verifyBlobRuntime(coreRuntime);
verifyBlobDeclarations();

const contentReactOutput = readdirSync(join(contentReactRoot, "dist"))
  .filter((file) => file.endsWith(".mjs") || file.endsWith(".d.mts"))
  .map((file) => readFileSync(join(contentReactRoot, "dist", file), "utf8"))
  .join("\n");
if (
  !contentReactOutput.includes("validateTopikAssetReference") ||
  !contentReactOutput.includes("TopikGeneratedAssetName")
) {
  throw new Error("Content renderer package does not preserve canonical generated-name boundaries");
}

verifyPackedTypeBoundaries();

const schemaPackage = JSON.parse(readFileSync(join(schemaRoot, "package.json"), "utf8"));
if (schemaPackage.exports?.["."] !== undefined) {
  throw new Error("Schema resources must not be exported through an unversioned root entry");
}
if (schemaPackage.exports?.["./*.json"] !== "./dist/*.json") {
  throw new Error("Versioned JSON Schema wildcard export is missing or incorrect");
}
if (
  schemaPackage.exports?.["./*"]?.types !== "./dist/*.d.mts" ||
  schemaPackage.exports?.["./*"]?.import !== "./dist/*.mjs"
) {
  throw new Error("Versioned type wildcard export is missing or incorrect");
}

const expected = new Map([
  [
    schemaRoot,
    [
      "LICENSE",
      ...schemaTargets.flatMap(({ resource, version }) => [
        `dist/${resource}/${version}.json`,
        `dist/${resource}/${version}.d.mts`,
        `dist/${resource}/${version}.mjs`,
      ]),
      "package.json",
    ].sort(),
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

console.log("Schema exports, packlists, and Asset package boundaries verified");

function resolveLocalSchemaReference(rootSchema, schema) {
  let resolved = schema;
  const visited = new Set();

  while (typeof resolved?.$ref === "string") {
    const reference = resolved.$ref;
    if (!reference.startsWith("#/")) {
      throw new Error(`Asset/v1 contains unsupported schema reference ${reference}`);
    }
    if (visited.has(reference)) {
      throw new Error(`Asset/v1 contains a cyclic reference at ${reference}`);
    }
    visited.add(reference);
    resolved = reference
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, segment) => value?.[segment], rootSchema);
  }

  return resolved;
}

function verifyPackedTypeBoundaries() {
  const temporary = mkdtempSync(join(tmpdir(), "topik-packed-types-"));
  try {
    const modules = join(temporary, "node_modules");
    const scope = join(modules, "@topik");
    mkdirSync(scope, { recursive: true });
    for (const [name, directory] of [
      ["schema", schemaRoot],
      ["content-schema", contentSchemaRoot],
      ["core", coreRoot],
    ]) {
      const before = new Set(readdirSync(temporary));
      execFileSync("pnpm", ["pack", "--pack-destination", temporary], {
        cwd: directory,
        stdio: "ignore",
      });
      const archive = readdirSync(temporary).find(
        (entry) => entry.endsWith(".tgz") && !before.has(entry),
      );
      if (archive === undefined) throw new Error(`Packed declarations are missing for ${name}`);
      const destination = join(scope, name);
      mkdirSync(destination, { recursive: true });
      execFileSync(
        "tar",
        ["-xzf", join(temporary, archive), "-C", destination, "--strip-components=1"],
        { stdio: "ignore" },
      );
    }

    mkdirSync(join(modules, "@markdoc"), { recursive: true });
    symlinkSync(
      join(root, "node_modules", "@markdoc", "markdoc"),
      join(modules, "@markdoc", "markdoc"),
      "dir",
    );
    symlinkSync(join(root, "node_modules", "zod"), join(modules, "zod"), "dir");
    writeFileSync(
      join(temporary, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    for (const { fixtureClass, fixtures } of [
      {
        fixtureClass: "valid",
        fixtures: ["generated-asset-name-valid", "asset-blob-uri-valid"],
      },
      {
        fixtureClass: "invalid",
        fixtures: ["generated-asset-name-invalid", "asset-blob-uri-invalid"],
      },
    ]) {
      for (const fixture of fixtures) {
        copyFileSync(join(typeFixtureRoot, `${fixture}.fixture`), join(temporary, `${fixture}.ts`));
      }
      const config = `tsconfig-${fixtureClass}.json`;
      writeFileSync(
        join(temporary, config),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "NodeNext",
              moduleResolution: "NodeNext",
              noEmit: true,
              skipLibCheck: true,
              strict: true,
              target: "ES2022",
              types: [],
            },
            files: fixtures.map((fixture) => `${fixture}.ts`),
          },
          null,
          2,
        )}\n`,
      );
      execFileSync(join(schemaRoot, "node_modules", ".bin", "tsc"), ["--project", config], {
        cwd: temporary,
        stdio: "pipe",
      });
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyGeneratedNameRuntime(packageName, accepts) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  for (const finalSymbol of alphabet) {
    const candidate = `auto-v1-${"a".repeat(51)}${finalSymbol}`;
    const expected = finalSymbol === "a" || finalSymbol === "q";
    if (accepts(candidate) !== expected) {
      throw new Error(`${packageName} generated-name final-symbol grammar is not canonical`);
    }
  }
  for (const candidate of [
    `auto-v1-${"a".repeat(51)}`,
    `auto-v1-${"a".repeat(53)}`,
    `auto-v1-${"a".repeat(51)}0`,
    `auto-v1-${"A".repeat(51)}a`,
    `asset-v1-${"a".repeat(52)}`,
    `auto-v1-${"a".repeat(51)}a=`,
  ]) {
    if (accepts(candidate)) {
      throw new Error(`${packageName} accepted a noncanonical generated Asset name`);
    }
  }
}

function verifyBlobRuntime(coreRuntime) {
  const digest = "0".repeat(64);
  const canonicalUri = `blobs/${digest}`;
  const asset = {
    apiVersion: "v1",
    type: "Asset",
    name: `auto-v1-${"a".repeat(52)}`,
    spec: {
      uri: canonicalUri,
      integrity: `sha256:${digest}`,
      mediaType: "application/octet-stream",
      size: 0,
    },
  };
  if (!coreRuntime.validateAssetValue(asset).ok) throw new Error("Core rejects canonical blob URI");
  if (
    !coreRuntime.isAssetBlobUri(canonicalUri) ||
    coreRuntime.parseAssetBlobUri(canonicalUri) !== canonicalUri
  ) {
    throw new Error("Packaged core runtime rejects canonical blob-URI admission");
  }
  for (const invalid of [
    `blobs/${"0".repeat(63)}`,
    `blobs/${"0".repeat(65)}`,
    `blobs/${"g".repeat(64)}`,
    `blobs/${"A".repeat(64)}`,
    `blob/${digest}`,
    `assets/sha256/${digest}`,
  ]) {
    if (coreRuntime.isAssetBlobUri(invalid)) {
      throw new Error("Packaged core runtime admits a noncanonical blob URI");
    }
    try {
      coreRuntime.parseAssetBlobUri(invalid);
      throw new Error("Packaged core parser admits a noncanonical blob URI");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  const alternate = {
    ...asset,
    spec: { ...asset.spec, uri: `https://cdn.example.com/${digest}` },
  };
  if (!coreRuntime.validateAssetValue(alternate).ok) throw new Error("Core rejects general URI");
  if (
    coreRuntime.TOPIK_BLOB_OUTPUT_PREFIX !== "blobs" ||
    Object.hasOwn(coreRuntime, "TOPIK_ASSET_OUTPUT_PREFIX")
  ) {
    throw new Error("Packaged core blob-prefix exports are incoherent");
  }
}

function verifyBlobDeclarations() {
  const schemaDeclarations = readFileSync(join(schemaRoot, "dist", "asset", "v1.d.mts"), "utf8");
  if (
    !schemaDeclarations.includes("uri: string;") ||
    schemaDeclarations.includes("AssetBlobUri") ||
    schemaDeclarations.includes("GeneratedAssetName") ||
    schemaDeclarations.includes("hasMatchingAssetDigests") ||
    schemaDeclarations.includes("uri: `blobs/${string}`;") ||
    schemaDeclarations.includes("assets/sha256")
  ) {
    throw new Error("Packaged schema declarations contain compiler-specific Asset APIs");
  }

  const coreDeclarations = readFileSync(join(coreRoot, "dist", "index.d.mts"), "utf8");
  if (
    !coreDeclarations.includes("AssetBlobUri") ||
    !coreDeclarations.includes("resolveWikiNavigation") ||
    !coreDeclarations.includes("path: AssetBlobUri;") ||
    !/declare function validateAssetBlobUri[\s\S]+?uri: AssetBlobUri;/u.test(coreDeclarations) ||
    coreDeclarations.includes("uri: `blobs/${string}`;") ||
    coreDeclarations.includes("assets/sha256")
  ) {
    throw new Error("Packaged core declarations do not preserve opaque blob-URI admission");
  }
}
