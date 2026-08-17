import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTERNAL_RUNTIME_DEPENDENCIES,
  FEATURE_FLOORS,
  IMMUTABLE_TAG_PATTERN,
  NODE_ENGINES,
  PACKAGE_DIRECTORIES,
  PLAN_PATH,
  PUBLIC_PACKAGES,
  RELEASE_VERSION_PATTERN,
  RESOURCE_VERSIONS,
} from "./constants.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const TOP_LEVEL_FIELDS = Object.freeze([
  "planSchemaVersion",
  "contentSchemaVersion",
  "releaseVersion",
  "gitTag",
  "candidateTag",
  "adoptionLane",
  "packages",
  "resourceVersions",
  "featureFloors",
  "migrations",
  "consumerGate",
]);

export async function loadReleaseContext(workspaceRoot) {
  const plan = await loadReleasePlan(workspaceRoot);
  const manifests = await loadAndValidateManifests(workspaceRoot, plan);
  await validateResourceSchemas(workspaceRoot, plan);
  await validateContentSchemaVersion(workspaceRoot, plan);
  return { plan, manifests };
}

export async function loadReleasePlan(workspaceRoot) {
  const text = await readText(join(workspaceRoot, PLAN_PATH), "release plan");
  return validatePlanObject(parseStrictJson(text, "release plan"));
}

export function validatePlanObject(plan) {
  assertRecord(plan, "release plan");
  assertExactFields(plan, TOP_LEVEL_FIELDS, "release plan");
  if (plan.planSchemaVersion !== 1) throw new Error("release plan planSchemaVersion must be 1");
  if (
    typeof plan.contentSchemaVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(plan.contentSchemaVersion)
  ) {
    throw new Error("release plan has an invalid contentSchemaVersion");
  }
  if (
    typeof plan.releaseVersion !== "string" ||
    !RELEASE_VERSION_PATTERN.test(plan.releaseVersion)
  ) {
    throw new Error("release plan has an unsupported releaseVersion");
  }
  if (typeof plan.gitTag !== "string" || !IMMUTABLE_TAG_PATTERN.test(plan.gitTag)) {
    throw new Error("release plan has an unsafe gitTag");
  }
  if (plan.gitTag !== `v${plan.releaseVersion}`) {
    throw new Error("release plan gitTag and releaseVersion disagree");
  }
  if (plan.candidateTag !== "candidate" || plan.adoptionLane !== "alpha") {
    throw new Error("release plan must use candidate publication and the alpha adoption lane");
  }
  assertExactStringSet(plan.packages, PUBLIC_PACKAGES, "release plan packages");

  assertRecord(plan.resourceVersions, "release plan resourceVersions");
  assertExactFields(plan.resourceVersions, ["readable", "writable"], "resourceVersions");
  assertExactStringSet(
    plan.resourceVersions.readable,
    RESOURCE_VERSIONS,
    "readable resourceVersions",
  );
  assertExactStringSet(
    plan.resourceVersions.writable,
    RESOURCE_VERSIONS,
    "writable resourceVersions",
  );

  if (!Array.isArray(plan.featureFloors) || plan.featureFloors.length === 0) {
    throw new Error("release plan featureFloors must be a non-empty array");
  }
  const features = new Set();
  for (const floor of plan.featureFloors) {
    assertRecord(floor, "feature floor");
    assertExactFields(floor, ["feature", "minimumVersion"], "feature floor");
    if (typeof floor.feature !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(floor.feature)) {
      throw new Error("release plan has an unsafe feature name");
    }
    if (features.has(floor.feature)) throw new Error("release plan has a duplicate feature floor");
    features.add(floor.feature);
    if (floor.minimumVersion !== plan.releaseVersion) {
      throw new Error("feature floor must name the planned cohort version");
    }
  }
  assertExactStringSet([...features], FEATURE_FLOORS, "release plan featureFloors");

  if (!Array.isArray(plan.migrations)) throw new Error("release plan migrations must be an array");
  const migrations = new Set();
  for (const migration of plan.migrations) {
    assertRecord(migration, "migration");
    assertExactFields(migration, ["id", "fromVersion", "toVersion", "required"], "migration");
    if (typeof migration.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.id)) {
      throw new Error("release plan has an unsafe migration id");
    }
    if (migrations.has(migration.id)) throw new Error("release plan has a duplicate migration");
    migrations.add(migration.id);
    if (
      typeof migration.fromVersion !== "string" ||
      !RELEASE_VERSION_PATTERN.test(migration.fromVersion) ||
      migration.toVersion !== plan.releaseVersion ||
      migration.required !== true
    ) {
      throw new Error("release plan has an invalid migration");
    }
  }

  assertRecord(plan.consumerGate, "release plan consumerGate");
  assertExactFields(plan.consumerGate, ["kind", "requiredBeforeLanePromotion"], "consumerGate");
  if (
    plan.consumerGate.kind !== "private-manual" ||
    plan.consumerGate.requiredBeforeLanePromotion !== true
  ) {
    throw new Error("release plan must require the private manual consumer gate");
  }
  return plan;
}

export async function loadAndValidateManifests(workspaceRoot, plan) {
  const manifests = new Map();
  for (const name of PUBLIC_PACKAGES) {
    const manifestPath = join(workspaceRoot, PACKAGE_DIRECTORIES[name], "package.json");
    const manifest = parseStrictJson(
      await readText(manifestPath, `${name} manifest`),
      `${name} manifest`,
    );
    validatePublicManifest(name, manifest, plan.releaseVersion);
    manifests.set(name, manifest);
  }

  const packageDirectories = await readdir(join(workspaceRoot, "packages"), {
    withFileTypes: true,
  });
  for (const directory of packageDirectories) {
    if (!directory.isDirectory()) continue;
    const text = await readFile(
      join(workspaceRoot, "packages", directory.name, "package.json"),
      "utf8",
    ).catch(() => null);
    if (text === null) continue;
    const manifest = parseStrictJson(text, "workspace package manifest");
    assertRecord(manifest, "workspace package manifest");
    if (typeof manifest.name !== "string" || !manifest.name.startsWith("@topik/")) continue;
    if (manifest.private === true) {
      if (plan.packages.includes(manifest.name)) {
        throw new Error("release plan includes a private package");
      }
    } else if (!plan.packages.includes(manifest.name)) {
      throw new Error("release plan omits a public Topik package");
    }
  }
  return manifests;
}

export function validatePublicManifest(name, manifest, version, { packed = false } = {}) {
  assertRecord(manifest, `${name} manifest`);
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`${name} manifest identity does not match the release plan`);
  }
  if (manifest.private === true) throw new Error(`${name} must not be private`);
  if (manifest.license !== "MIT") throw new Error(`${name} must declare the MIT license`);
  assertRecord(manifest.repository, `${name} repository`);
  assertExactFields(manifest.repository, ["type", "url", "directory"], `${name} repository`);
  if (
    manifest.repository.type !== "git" ||
    manifest.repository.url !== "git+https://github.com/subtopik/topik.git" ||
    manifest.repository.directory !== PACKAGE_DIRECTORIES[name]
  ) {
    throw new Error(`${name} must declare the canonical public repository`);
  }
  assertRecord(manifest.publishConfig, `${name} publishConfig`);
  assertExactFields(manifest.publishConfig, ["access"], `${name} publishConfig`);
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${name} must publish with public access`);
  }
  if (manifest.engines?.node !== NODE_ENGINES) {
    throw new Error(`${name} has an unsupported Node engine range`);
  }
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 1 ||
    manifest.files[0] !== "dist"
  ) {
    throw new Error(`${name} must publish its dist directory`);
  }

  const dependencies = manifest.dependencies ?? Object.create(null);
  assertRecord(dependencies, `${name} dependencies`);
  const expectedExternal = EXTERNAL_RUNTIME_DEPENDENCIES[name];
  for (const [dependency, expectedVersion] of Object.entries(expectedExternal)) {
    if (dependencies[dependency] !== expectedVersion) {
      throw new Error(`${name} must exact-pin ${dependency}`);
    }
  }
  for (const [dependency, dependencyVersion] of Object.entries(dependencies)) {
    if (dependency.startsWith("@topik/")) {
      const allowedVersion = packed
        ? version
        : [version, `workspace:${version}`].includes(dependencyVersion);
      if (!PUBLIC_PACKAGES.includes(dependency) || !allowedVersion) {
        throw new Error(`${name} has an invalid internal cohort dependency`);
      }
      continue;
    }
    if (expectedExternal[dependency] !== dependencyVersion) {
      throw new Error(`${name} has an unverified public runtime dependency`);
    }
    if (!isExactVersion(dependencyVersion)) {
      throw new Error(`${name} has a non-exact public runtime dependency`);
    }
  }
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const entries = manifest[section];
    if (entries === undefined) continue;
    assertRecord(entries, `${name} ${section}`);
    for (const [dependency, dependencyVersion] of Object.entries(entries)) {
      if (
        dependency.startsWith("@topik/") &&
        ![version, `workspace:${version}`].includes(dependencyVersion)
      ) {
        throw new Error(`${name} has an unsafe internal dependency in ${section}`);
      }
    }
  }
  return manifest;
}

async function validateResourceSchemas(workspaceRoot, plan) {
  const discovered = [];
  const schemaRoot = join(workspaceRoot, "packages", "schema", "src");
  const directories = await readdir(schemaRoot, { withFileTypes: true });
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const schemaPath = join(schemaRoot, directory.name, "v1.json");
    const text = await readFile(schemaPath, "utf8").catch(() => null);
    if (text === null) continue;
    const schema = parseStrictJson(text, "resource schema");
    assertRecord(schema, "resource schema");
    const resourceType = schema.properties?.type?.const;
    const apiVersion = schema.properties?.apiVersion?.const;
    if (typeof resourceType !== "string" || apiVersion !== "v1") {
      throw new Error("resource schema has an invalid version declaration");
    }
    discovered.push(`${resourceType}/${apiVersion}`);
  }
  assertExactStringSet(discovered, plan.resourceVersions.readable, "discovered resource schemas");
  assertExactStringSet(discovered, plan.resourceVersions.writable, "writable resource schemas");
}

async function validateContentSchemaVersion(workspaceRoot, plan) {
  const source = await readText(
    join(workspaceRoot, "packages", "content-schema", "src", "components.ts"),
    "content schema version source",
  );
  const match = /export const TOPIK_CONTENT_SCHEMA_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)";/u.exec(
    source,
  );
  if (match === null || match[1] !== plan.contentSchemaVersion) {
    throw new Error("release plan contentSchemaVersion does not match the public runtime");
  }
}

export function assertExactFields(value, expected, label) {
  const fields = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const allowed = [...expected].sort((left, right) => left.localeCompare(right));
  if (fields.length !== allowed.length || fields.some((field, index) => field !== allowed[index])) {
    throw new Error(`${label} has missing or unexpected fields`);
  }
}

export function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

export function assertExactStringSet(actual, expected, label) {
  if (!Array.isArray(actual) || actual.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  const unique = new Set(actual);
  if (unique.size !== actual.length) throw new Error(`${label} contains duplicates`);
  const left = [...actual].sort((a, b) => a.localeCompare(b));
  const right = [...expected].sort((a, b) => a.localeCompare(b));
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) {
    throw new Error(`${label} does not match the supported set`);
  }
}

function isExactVersion(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version);
}

async function readText(path, label) {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} could not be read`);
  }
}
