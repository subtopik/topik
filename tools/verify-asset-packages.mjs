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

const root = join(import.meta.dirname, "..");
const schemaRoot = join(root, "packages", "schema");
const coreRoot = join(root, "packages", "core");
const contentSchemaRoot = join(root, "packages", "content-schema");
const contentReactRoot = join(root, "packages", "content-react");
const generatedNamePattern = "^auto-v1-[a-z2-7]{51}[aq]$";
const typeFixtureRoot = join(root, "tools", "type-fixtures");

const sourceSchema = readFileSync(join(schemaRoot, "src", "asset-v1.json"));
const builtSchema = readFileSync(join(schemaRoot, "dist", "asset-v1.json"));
if (!sourceSchema.equals(builtSchema))
  throw new Error("Asset/v1 source and packaged schemas differ");
if (JSON.parse(sourceSchema).properties?.name?.pattern !== generatedNamePattern) {
  throw new Error("Asset/v1 generated-name grammar is not canonical");
}

const schemaRuntime = await import(pathToFileURL(join(schemaRoot, "dist", "index.mjs")));
const contentSchemaRuntime = await import(
  pathToFileURL(join(contentSchemaRoot, "dist", "index.mjs"))
);
const coreRuntime = await import(pathToFileURL(join(coreRoot, "dist", "index.mjs")));
verifyGeneratedNameRuntime("schema", (name) => schemaRuntime.isGeneratedAssetName(name));
verifyGeneratedNameRuntime(
  "content-schema",
  (name) => contentSchemaRuntime.validateTopikAssetReference(`asset:${name}`).valid,
);
verifyGeneratedNameRuntime("core", (name) => coreRuntime.isGeneratedAssetName(name));

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

verifyPackedGeneratedNameTypes();

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

function verifyPackedGeneratedNameTypes() {
  const temporary = mkdtempSync(join(tmpdir(), "topik-generated-name-types-"));
  try {
    const modules = join(temporary, "node_modules");
    const scope = join(modules, "@topik");
    mkdirSync(scope, { recursive: true });
    for (const [name, directory] of [
      ["schema", schemaRoot],
      ["content-schema", contentSchemaRoot],
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
    for (const fixture of ["generated-asset-name-valid", "generated-asset-name-invalid"]) {
      copyFileSync(join(typeFixtureRoot, `${fixture}.fixture`), join(temporary, `${fixture}.ts`));
    }
    writeFileSync(
      join(temporary, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    writeFileSync(
      join(temporary, "tsconfig.json"),
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
          files: ["generated-asset-name-valid.ts", "generated-asset-name-invalid.ts"],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"], {
      cwd: temporary,
      stdio: "pipe",
    });
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
