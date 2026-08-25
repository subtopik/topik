import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { packPublicPackages } from "./pack-public-package.mjs";
import { listNpmRootMetadata } from "./public-packlist.mjs";
import { publicPackages } from "./publish-alpha.mjs";

const root = join(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "topik-public-packages-"));

try {
  const consumer = join(temporary, "consumer");
  mkdirSync(consumer);
  const { archives, cohortVersion } = packPublicPackages(root, join(temporary, "packing"));
  const manifests = new Map();

  for (const packageName of publicPackages) {
    const archive = archives.get(packageName);
    if (archive === undefined) throw new Error(`No archive was produced for ${packageName}`);
    const packageRoot = join(root, "packages", packageName.slice("@topik/".length));
    verifyPacklist(packageRoot, archive);
    manifests.set(packageName, readPackedManifest(archive));
  }
  verifyCohort(manifests, cohortVersion);

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          publicPackages.map((packageName) => [packageName, `file:${archives.get(packageName)}`]),
        ),
        devDependencies: { typescript: lockedTypescriptVersion() },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--package-lock=false"], {
    cwd: consumer,
    stdio: "inherit",
  });

  const modules = join(consumer, "node_modules");
  const modulesBoundary = `${realpathSync(modules)}${sep}`;
  for (const packageName of publicPackages) {
    const packageRoot = join(root, "packages", packageName.slice("@topik/".length));
    const destination = join(modules, packageName);
    if (
      lstatSync(destination).isSymbolicLink() ||
      !realpathSync(destination).startsWith(modulesBoundary)
    ) {
      throw new Error(`${packageName} is not installed inside the clean consumer`);
    }
    const installedManifest = readJson(join(destination, "package.json"));
    const packedManifest = manifests.get(packageName);
    if (JSON.stringify(installedManifest) !== JSON.stringify(packedManifest)) {
      throw new Error(`${packageName} installed manifest differs from its packed manifest`);
    }
    verifyManifest(packageName, destination, installedManifest);
    if (
      readFileSync(join(destination, "LICENSE"), "utf8") !==
      readFileSync(join(packageRoot, "LICENSE"), "utf8")
    ) {
      throw new Error(`${packageName} packed license differs from its declared package license`);
    }
  }

  verifyConsumer(consumer);
  verifyDeclarations(consumer);
  verifyBins(modules);
  console.log(`Verified packed public package cohort ${cohortVersion}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function verifyCohort(manifests, cohortVersion) {
  if (typeof cohortVersion !== "string" || !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(cohortVersion)) {
    throw new Error("Public packages do not expose one alpha cohort version");
  }
  for (const [packageName, manifest] of manifests) {
    if (manifest.version !== cohortVersion) {
      throw new Error(`${packageName} is outside the ${cohortVersion} public cohort`);
    }
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, version] of Object.entries(dependencies ?? {})) {
        if (version.startsWith("catalog:") || version.startsWith("workspace:")) {
          throw new Error(`${packageName} packs unresolved metadata for ${dependency}`);
        }
      }
    }
    for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
      if (dependency.startsWith("@topik/") && version !== cohortVersion) {
        throw new Error(`${packageName} does not pin ${dependency} to ${cohortVersion}`);
      }
    }
  }
}

function verifyPacklist(packageRoot, archive) {
  const actual = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
    .map((entry) => entry.replace(/^package\//u, ""))
    .toSorted((left, right) => left.localeCompare(right));
  const expected = [
    "package.json",
    ...listNpmRootMetadata(packageRoot),
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
    if (content.includes(root)) {
      throw new Error(`${packageName} embeds its workspace path in ${file}`);
    }
  }
}

function exportTargets(exports) {
  if (typeof exports === "string") return [exports];
  if (exports === null || typeof exports !== "object") return [];
  return Object.values(exports).flatMap((value) => exportTargets(value));
}

function verifyConsumer(consumer) {
  const script = join(consumer, "runtime.mjs");
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

const modulePrefix = new URL("./node_modules/", import.meta.url).href;
const topikPrefix = new URL("./node_modules/@topik/", import.meta.url).href;
for (const specifier of ["@topik/content-schema", "@topik/core", "@topik/content-react", "@topik/content-react/rich", "@topik/content-react/theme", "@topik/schema/guide/v1.json"]) {
  assert.ok(import.meta.resolve(specifier).startsWith(topikPrefix), specifier + " resolved outside the packed cohort");
}
assert.ok(import.meta.resolve("react-dom/server").startsWith(modulePrefix), "react-dom resolved outside the clean consumer");
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

function verifyDeclarations(consumer) {
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
  const compiler = join(consumer, "node_modules", "typescript", "bin", "tsc");
  const consumerBoundary = `${realpathSync(consumer)}${sep}`;
  if (!realpathSync(compiler).startsWith(consumerBoundary)) {
    throw new Error("TypeScript is not installed inside the clean consumer");
  }
  execFileSync(process.execPath, [compiler, "--project", config], {
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
      { encoding: "utf8" },
    );
    if (!output.includes(expected)) {
      throw new Error(`Packed ${bin} did not execute its public help boundary`);
    }
  }
}

function readPackedManifest(archive) {
  return JSON.parse(
    execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
  );
}

function lockedTypescriptVersion() {
  const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const match =
    /^    typescript:\r?\n      specifier: [^\r\n]+\r?\n      version: ['"]?([^'"\s]+)['"]?\r?$/mu.exec(
      lockfile,
    );
  if (match === null || !/^\d+\.\d+\.\d+$/u.test(match[1])) {
    throw new Error("The default catalog does not lock one exact TypeScript version");
  }
  return match[1];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
