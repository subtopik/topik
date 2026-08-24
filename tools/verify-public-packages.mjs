import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const publicPackages = [
  "@topik/content-schema",
  "@topik/schema",
  "@topik/core",
  "@topik/content-react",
  "@topik/cli",
  "@topik/codemod",
];
const externalModules = [
  "@drizzle-team",
  "@markdoc",
  "@types",
  "ajv",
  "ajv-formats",
  "chokidar",
  "entities",
  "github-slugger",
  "katex",
  "mermaid",
  "react",
  "react-dom",
  "shiki",
  "yaml",
  "zod",
];
const temporary = mkdtempSync(join(tmpdir(), "topik-public-packages-"));

try {
  const archiveDirectory = join(temporary, "archives");
  const modules = join(temporary, "consumer", "node_modules");
  const scope = join(modules, "@topik");
  mkdirSync(archiveDirectory, { recursive: true });
  mkdirSync(scope, { recursive: true });

  const manifests = new Map();
  for (const packageName of publicPackages) {
    const shortName = packageName.slice("@topik/".length);
    const packageRoot = join(root, "packages", shortName);
    const archive = pack(packageRoot, archiveDirectory);
    verifyPacklist(packageRoot, archive);

    const destination = join(scope, shortName);
    mkdirSync(destination, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "-C", destination, "--strip-components=1"]);
    const manifest = readJson(join(destination, "package.json"));
    manifests.set(packageName, manifest);
    verifyManifest(packageName, destination, manifest);
    if (
      readFileSync(join(destination, "LICENSE"), "utf8") !==
      readFileSync(join(packageRoot, "LICENSE"), "utf8")
    ) {
      throw new Error(`${packageName} packed license differs from its declared package license`);
    }
  }

  const cohortVersion = manifests.get(publicPackages[0])?.version;
  if (typeof cohortVersion !== "string" || !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(cohortVersion)) {
    throw new Error("Public packages do not expose one alpha cohort version");
  }
  for (const [packageName, manifest] of manifests) {
    if (manifest.version !== cohortVersion) {
      throw new Error(`${packageName} is outside the ${cohortVersion} public cohort`);
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@topik/") && version !== cohortVersion) {
        throw new Error(`${packageName} does not pin ${dependency} to ${cohortVersion}`);
      }
    }
  }

  linkExternalModules(modules);
  verifyConsumer(modules);
  verifyDeclarations(modules);
  verifyBins(modules);
  console.log(`Verified packed public package cohort ${cohortVersion}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function pack(packageRoot, archiveDirectory) {
  const before = new Set(readdirSync(archiveDirectory));
  execFileSync("pnpm", ["pack", "--pack-destination", archiveDirectory], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  const archive = readdirSync(archiveDirectory).find(
    (entry) => entry.endsWith(".tgz") && !before.has(entry),
  );
  if (archive === undefined) throw new Error(`No archive was produced for ${packageRoot}`);
  return join(archiveDirectory, archive);
}

function verifyPacklist(packageRoot, archive) {
  const actual = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//u, ""))
    .toSorted((left, right) => left.localeCompare(right));
  const expected = [
    "LICENSE",
    "package.json",
    ...listFiles(join(packageRoot, "dist"), "dist"),
  ].toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected packed files for ${packageRoot}: ${actual.join(", ")}`);
  }
}

function listFiles(directory, prefix) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(path, relativePath) : [relativePath];
  });
}

function verifyManifest(packageName, destination, manifest) {
  if (manifest.name !== packageName || manifest.private === true || manifest.license !== "MIT") {
    throw new Error(`${packageName} packed manifest has invalid public metadata`);
  }
  if (
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files) !== JSON.stringify(["dist"])
  ) {
    throw new Error(`${packageName} packed manifest has an unexpected files boundary`);
  }
  for (const target of exportTargets(manifest.exports)) {
    if (target.includes("/src/") || target.startsWith("./src/")) {
      throw new Error(`${packageName} exposes repository source through ${target}`);
    }
    if (target.includes("*")) continue;
    if (!statSync(join(destination, target)).isFile()) {
      throw new Error(`${packageName} export target is missing: ${target}`);
    }
    if (target.endsWith(".mjs")) {
      const declaration = target.replace(/\.mjs$/u, ".d.mts");
      if (!statSync(join(destination, declaration)).isFile()) {
        throw new Error(`${packageName} declaration target is missing: ${declaration}`);
      }
    }
  }
  for (const target of Object.values(manifest.bin ?? {})) {
    if (typeof target !== "string" || !statSync(join(destination, target)).isFile()) {
      throw new Error(`${packageName} packed bin target is missing`);
    }
  }
  for (const file of listFiles(join(destination, "dist"), "dist")) {
    if (!/\.(?:mjs|mts)$/u.test(file)) continue;
    const content = readFileSync(join(destination, file), "utf8");
    if (content.includes(root))
      throw new Error(`${packageName} embeds its workspace path in ${file}`);
  }
}

function exportTargets(exports) {
  if (typeof exports === "string") return [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.values(exports).flatMap((value) => exportTargets(value));
}

function linkExternalModules(modules) {
  for (const moduleName of externalModules) {
    const sourcePath = [
      join(root, "node_modules", moduleName),
      ...["content-schema", "core", "content-react", "cli", "codemod", "schema"].map(
        (packageName) => join(root, "packages", packageName, "node_modules", moduleName),
      ),
    ].find((candidate) => existsSync(candidate));
    if (sourcePath === undefined)
      throw new Error(`Workspace dependency is unavailable: ${moduleName}`);
    const source = realpathSync(sourcePath);
    const destination = join(modules, moduleName);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination, "dir");
  }
}

function verifyConsumer(modules) {
  const consumer = dirname(modules);
  const script = join(consumer, "runtime.mjs");
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    script,
    `import assert from "node:assert/strict";
import { validateTopikContent } from "@topik/content-schema";
import { isGeneratedAssetName, validateResources } from "@topik/core";
import { renderTopikMarkdown } from "@topik/content-react";
import * as rich from "@topik/content-react/rich";
import * as theme from "@topik/content-react/theme";
import guideSchema from "@topik/schema/guide/v1.json" with { type: "json" };
import { renderToStaticMarkup } from "react-dom/server";

const prefix = new URL("./node_modules/@topik/", import.meta.url).href;
for (const specifier of ["@topik/content-schema", "@topik/core", "@topik/content-react", "@topik/content-react/rich", "@topik/content-react/theme", "@topik/schema/guide/v1.json"]) {
  assert.ok(import.meta.resolve(specifier).startsWith(prefix), specifier + " resolved outside the packed cohort");
}
assert.equal(guideSchema.properties.type.const, "Guide");
assert.equal(validateTopikContent("# Packed").valid, true);
assert.equal(validateTopikContent("{% unknown /%}").valid, false);
assert.equal(isGeneratedAssetName("auto-v1-" + "a".repeat(52)), true);
assert.deepEqual(validateResources([{ apiVersion: "v1", type: "Guide", name: "packed", spec: { title: "Packed", slug: "packed", content: { format: "topik", value: "# Packed" } } }]), { valid: true, errors: [] });
assert.deepEqual(validateResources([{ apiVersion: "v2", type: "Guide", name: "packed", spec: {} }]).errors, [{ id: "resource-unsupported-version", resource: "Guide/packed", path: "/apiVersion", message: "Unsupported Guide apiVersion: v2" }]);
assert.match(renderToStaticMarkup(renderTopikMarkdown("# Packed")), /<h1 id="packed">Packed<\\/h1>/u);
assert.equal(typeof rich.RichTopikContentProvider, "function");
assert.equal(typeof theme.TopikContent, "function");
`,
  );
  execFileSync(process.execPath, [script], { cwd: consumer, stdio: "inherit" });
}

function verifyDeclarations(modules) {
  const consumer = dirname(modules);
  const fixture = join(consumer, "types.mts");
  writeFileSync(
    fixture,
    `import type { Guide } from "@topik/schema/guide/v1";
import { validateTopikContent } from "@topik/content-schema";
import { validateResources } from "@topik/core";
import { renderTopikMarkdown } from "@topik/content-react";
import { RichTopikContentProvider } from "@topik/content-react/rich";
import { TopikContent } from "@topik/content-react/theme";

const guide: Guide = { apiVersion: "v1", type: "Guide", name: "packed", spec: { title: "Packed", slug: "packed", content: { format: "topik", value: "# Packed" } } };
validateTopikContent(guide.spec.content.value);
validateResources([guide]);
renderTopikMarkdown(guide.spec.content.value);
void RichTopikContentProvider;
void TopikContent;
`,
  );
  const config = join(consumer, "tsconfig.json");
  writeFileSync(
    config,
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
          types: [],
        },
        files: ["types.mts"],
      },
      null,
      2,
    )}\n`,
  );
  execFileSync(join(root, "node_modules", ".bin", "tsc"), ["--project", config], {
    cwd: consumer,
    stdio: "inherit",
  });
}

function verifyBins(modules) {
  for (const [packageName, bin, expected] of [
    ["cli", "topik", "Topik CLI"],
    ["codemod", "topik-codemod", "Codemods for migrating content to Topik"],
  ]) {
    const manifest = readJson(join(modules, "@topik", packageName, "package.json"));
    const output = execFileSync(
      process.execPath,
      [join(modules, "@topik", packageName, manifest.bin[bin]), "--help"],
      {
        encoding: "utf8",
      },
    );
    if (!output.includes(expected))
      throw new Error(`Packed ${bin} did not execute its public help boundary`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
