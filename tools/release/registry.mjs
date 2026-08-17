import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  NODE_ENGINES,
  NPM_CLI_VERSION,
  NPM_REGISTRY,
  PUBLIC_PACKAGES,
  RELEASE_VERSION_PATTERN,
  SRI_PATTERN,
} from "./constants.mjs";
import { assertRecord } from "./plan.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const runFile = promisify(execFile);
const ALLOWED_DIST_TAGS = new Set(["candidate", "alpha", "latest"]);
const REGISTRY_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

export async function publishCandidate({ mode, plan, archives, registry }) {
  if (mode !== "initial" && mode !== "recovery") throw new Error("invalid publication mode");
  validateOperationInputs(plan, archives, registry);
  const existing = new Map();

  for (const name of plan.packages) {
    const state = await registry.getVersion(name, plan.releaseVersion);
    existing.set(name, state);
    if (mode === "initial" && state !== null) {
      throw new Error("initial publication found an existing planned version before publishing");
    }
    if (mode === "recovery" && state !== null) {
      validateRegistryVersion(state, archives.get(name), plan.releaseVersion);
    }
  }

  for (const name of plan.packages) {
    if (existing.get(name) !== null) continue;
    await registry.publish(archives.get(name), {
      access: "public",
      provenance: true,
      tag: plan.candidateTag,
    });
  }

  await verifyCompleteCohort(plan, archives, registry);
  await removePrereleaseLatest(plan, registry);
  for (const name of plan.packages) {
    await registry.setTag(name, plan.releaseVersion, plan.candidateTag);
  }
  await verifyTagAgreement(plan.packages, plan.candidateTag, plan.releaseVersion, registry);
}

export async function promoteAlpha({ plan, archives, registry }) {
  validateOperationInputs(plan, archives, registry);
  await verifyCompleteCohort(plan, archives, registry);

  const alphaTags = new Map();
  const candidateTags = new Map();
  for (const name of plan.packages) {
    alphaTags.set(name, await registry.getTag(name, plan.adoptionLane));
    candidateTags.set(name, await registry.getTag(name, plan.candidateTag));
  }

  const alphaComplete = plan.packages.every((name) => alphaTags.get(name) === plan.releaseVersion);
  const candidateCleanupOnly =
    alphaComplete &&
    plan.packages.every((name) => {
      const candidate = candidateTags.get(name);
      return candidate === null || candidate === plan.releaseVersion;
    });

  if (!candidateCleanupOnly) {
    for (const name of plan.packages) {
      if (candidateTags.get(name) !== plan.releaseVersion) {
        throw new Error("candidate tags are stale, missing, or mixed");
      }
    }
    await removePrereleaseLatest(plan, registry);

    // Remove every old lane tag before adding the first new one. A failed removal leaves the
    // cohort unavailable or old-only; retries continue forward and never restore removed tags.
    for (const name of plan.packages) {
      const current = await registry.getTag(name, plan.adoptionLane);
      if (current !== null && current !== plan.releaseVersion) {
        await registry.removeTag(name, plan.adoptionLane);
      }
    }
    for (const name of plan.packages) {
      const current = await registry.getTag(name, plan.adoptionLane);
      if (current !== null && current !== plan.releaseVersion) {
        throw new Error("old alpha tags remain; refusing to add the new cohort");
      }
    }
    for (const name of plan.packages) {
      const current = await registry.getTag(name, plan.adoptionLane);
      if (current === null) await registry.setTag(name, plan.releaseVersion, plan.adoptionLane);
      else if (current !== plan.releaseVersion) {
        throw new Error("alpha lane changed during promotion");
      }
    }
    await verifyTagAgreement(plan.packages, plan.adoptionLane, plan.releaseVersion, registry);
  }

  // Candidate cleanup is deliberately last. If it fails, a retry may finish cleanup only after
  // proving that alpha is already complete and every remaining candidate still names this cohort.
  for (const name of plan.packages) {
    const candidate = await registry.getTag(name, plan.candidateTag);
    if (candidate === plan.releaseVersion) await registry.removeTag(name, plan.candidateTag);
    else if (candidate !== null) throw new Error("candidate tag changed during promotion");
  }
  await verifyTagAgreement(plan.packages, plan.adoptionLane, plan.releaseVersion, registry);
  await verifyTagAgreement(plan.packages, plan.candidateTag, null, registry);
}

export async function verifyCompleteCohort(plan, archives, registry) {
  for (const name of plan.packages) {
    const state = await registry.getVersion(name, plan.releaseVersion);
    if (state === null) throw new Error("registry is missing part of the planned cohort");
    validateRegistryVersion(state, archives.get(name), plan.releaseVersion);
  }
}

export function validateRegistryVersion(state, archive, version) {
  assertRecord(state, "registry package metadata");
  if (archive === undefined || state.name !== archive.name || state.version !== version) {
    throw new Error("registry package identity does not match the local archive");
  }
  if (state.integrity !== archive.integrity || !SRI_PATTERN.test(state.integrity)) {
    throw new Error("registry integrity does not match the local archive");
  }
  if (state.provenance !== true) throw new Error("registry package has no verified provenance");
  if (state.access !== "public") throw new Error("registry package is not public");
  if (state.packageMetadata?.engines?.node !== NODE_ENGINES) {
    throw new Error("registry Node engines do not match");
  }
  if (!equalJsonValues(state.packageMetadata, packageMetadataFromManifest(archive.manifest))) {
    throw new Error("registry package metadata does not match the local archive");
  }
}

export async function removePrereleaseLatest(plan, registry) {
  for (const name of plan.packages) {
    const latest = await registry.getTag(name, "latest");
    if (typeof latest === "string" && latest.includes("-")) {
      await registry.removeTag(name, "latest");
    }
  }
}

export class NpmRegistry {
  constructor({ run = runNpm } = {}) {
    this.run = run;
  }

  async getVersion(name, version) {
    validatePackageAndVersion(name, version);
    const versionsValue = await this.run(["view", name, "versions", "--json"], "reading versions");
    const versions = typeof versionsValue === "string" ? [versionsValue] : versionsValue;
    if (
      !Array.isArray(versions) ||
      versions.some((entry) => typeof entry !== "string" || !REGISTRY_VERSION_PATTERN.test(entry))
    ) {
      throw new Error("registry returned an invalid version list");
    }
    if (!versions.includes(version)) return null;

    const metadata = await this.run(["view", `${name}@${version}`, "--json"], "reading metadata");
    assertRecord(metadata, "registry response");
    assertRecord(metadata.dist, "registry distribution metadata");
    const access = await this.getAccess(name);
    const attestations = metadata.dist.attestations;
    const provenance =
      attestations !== null &&
      typeof attestations === "object" &&
      typeof attestations.url === "string" &&
      attestations.url.startsWith("https://") &&
      typeof attestations.provenance?.predicateType === "string" &&
      attestations.provenance.predicateType.startsWith("https://slsa.dev/provenance/");
    return {
      name: metadata.name,
      version: metadata.version,
      integrity: metadata.dist.integrity,
      provenance,
      access,
      packageMetadata: packageMetadataFromManifest(metadata),
    };
  }

  async getTag(name, tag) {
    validatePackageAndTag(name, tag);
    const tags = await this.run(["view", name, "dist-tags", "--json"], "reading dist-tags");
    assertRecord(tags, "registry dist-tags");
    const value = tags[tag];
    if (value === undefined) return null;
    if (typeof value !== "string" || !REGISTRY_VERSION_PATTERN.test(value)) {
      throw new Error("registry returned an invalid dist-tag");
    }
    return value;
  }

  async publish(archive, options) {
    if (
      archive === undefined ||
      !PUBLIC_PACKAGES.includes(archive.name) ||
      options.access !== "public" ||
      options.provenance !== true ||
      options.tag !== "candidate"
    ) {
      throw new Error("unsafe npm publication request");
    }
    await this.run(
      ["publish", archive.path, "--provenance", "--access", "public", "--tag", "candidate"],
      `publishing ${archive.name}`,
      false,
    );
  }

  async setTag(name, version, tag) {
    validatePackageAndVersion(name, version);
    validatePackageAndTag(name, tag);
    if (tag === "latest") throw new Error("release tooling never sets latest");
    await this.run(["dist-tag", "add", `${name}@${version}`, tag], `setting ${tag}`, false);
  }

  async removeTag(name, tag) {
    validatePackageAndTag(name, tag);
    await this.run(["dist-tag", "rm", name, tag], `removing ${tag}`, false);
  }

  async getAccess(name) {
    if (!PUBLIC_PACKAGES.includes(name)) throw new Error("unsafe npm package name");
    const status = await this.run(["access", "get", "status", name, "--json"], "reading access");
    if (status === "public" || status === "private") return status;
    if (status !== null && typeof status === "object" && status[name] !== undefined) {
      if (status[name] === "public" || status[name] === "private") return status[name];
    }
    throw new Error("registry returned an invalid access status");
  }
}

async function verifyTagAgreement(packages, tag, expected, registry) {
  for (const name of packages) {
    if ((await registry.getTag(name, tag)) !== expected) {
      throw new Error(`${tag} tags do not agree across the cohort`);
    }
  }
}

function validateOperationInputs(plan, archives, registry) {
  if (
    plan === null ||
    !RELEASE_VERSION_PATTERN.test(plan.releaseVersion) ||
    plan.candidateTag !== "candidate" ||
    plan.adoptionLane !== "alpha" ||
    !Array.isArray(plan.packages) ||
    plan.packages.length !== PUBLIC_PACKAGES.length ||
    new Set(plan.packages).size !== PUBLIC_PACKAGES.length ||
    plan.packages.some((name) => !PUBLIC_PACKAGES.includes(name)) ||
    !(archives instanceof Map) ||
    archives.size !== PUBLIC_PACKAGES.length ||
    registry === null ||
    typeof registry !== "object"
  ) {
    throw new Error("unsafe release operation inputs");
  }
  for (const name of plan.packages) {
    const archive = archives.get(name);
    if (archive?.name !== name || archive.version !== plan.releaseVersion) {
      throw new Error("archive set does not match the release plan");
    }
  }
}

function validatePackageAndVersion(name, version) {
  if (!PUBLIC_PACKAGES.includes(name) || !REGISTRY_VERSION_PATTERN.test(version)) {
    throw new Error("unsafe npm package or version");
  }
}

function validatePackageAndTag(name, tag) {
  if (!PUBLIC_PACKAGES.includes(name) || !ALLOWED_DIST_TAGS.has(tag)) {
    throw new Error("unsafe npm package or dist-tag");
  }
}

export function packageMetadataFromManifest(manifest) {
  return {
    description: manifest.description,
    license: manifest.license,
    repository: manifest.repository,
    publishConfig: manifest.publishConfig,
    type: manifest.type,
    bin: normalizeBin(manifest.bin),
    exports: manifest.exports ?? null,
    engines: manifest.engines ?? {},
    dependencies: manifest.dependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
  };
}

function normalizeBin(bin) {
  if (bin === undefined || bin === null) return null;
  if (typeof bin !== "object" || Array.isArray(bin)) return bin;
  return Object.fromEntries(
    Object.entries(bin).map(([name, target]) => [
      name,
      typeof target === "string" ? target.replace(/^\.\//u, "") : target,
    ]),
  );
}

function equalJsonValues(left, right) {
  try {
    return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
  } catch {
    return false;
  }
}

function normalizeJson(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value !== "object") throw new Error("metadata is not JSON-compatible");
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

async function runNpm(arguments_, label, parse = true) {
  let stdout;
  try {
    ({ stdout } = await runFile("npx", ["-y", `npm@${NPM_CLI_VERSION}`, ...arguments_], {
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
        npm_config_registry: NPM_REGISTRY,
      },
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    throw new Error(`${label} failed`);
  }
  if (!parse) return null;
  return parseStrictJson(stdout, "registry response");
}
