import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  IMMUTABLE_TAG_PATTERN,
  NODE_ENGINES,
  NPM_CLI_VERSION,
  NPM_REGISTRY,
  PUBLISH_WORKFLOW_PATH,
  PUBLIC_PACKAGES,
  RELEASE_VERSION_PATTERN,
  SOURCE_REPOSITORY,
  SRI_PATTERN,
} from "./constants.mjs";
import { assertExactFields, assertExactStringSet, assertRecord } from "./plan.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const runFile = promisify(execFile);
const ALLOWED_DIST_TAGS = new Set(["candidate", "alpha", "latest"]);
const REGISTRY_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const NPM_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/u;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";
const INTOTO_STATEMENT = "https://in-toto.io/Statement/v1";
const INTOTO_PAYLOAD = "application/vnd.in-toto+json";
const GITHUB_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_BUILDER = "https://github.com/actions/runner/github-hosted";
const SIGSTORE_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";

export async function publishCandidate({ mode, plan, archives, registry, source }) {
  if (mode !== "initial" && mode !== "recovery") throw new Error("invalid publication mode");
  validateOperationInputs(plan, archives, registry, source);
  const existing = new Map();
  const candidateTags = new Map();

  for (const name of plan.packages) {
    existing.set(name, await registry.getVersion(name, plan.releaseVersion));
  }
  for (const name of plan.packages) {
    candidateTags.set(name, await registry.getTag(name, plan.candidateTag));
  }

  if (mode === "initial" && [...existing.values()].some((state) => state !== null)) {
    throw new Error("initial publication found an existing planned version before publishing");
  }
  if (mode === "initial" && [...candidateTags.values()].some((tag) => tag !== null)) {
    throw new Error("initial publication found existing candidate-tag ownership");
  }
  if (
    mode === "recovery" &&
    [...candidateTags.values()].some((tag) => tag !== null && tag !== plan.releaseVersion)
  ) {
    throw new Error("recovery found foreign or mixed candidate-tag ownership");
  }
  if (typeof registry.preflightAccess !== "function") {
    throw new Error("registry cannot preflight package access");
  }
  await registry.preflightAccess(plan.packages);
  await validateRegistryStates(existing, plan, archives, registry, source);
  await removePrereleaseLatest(plan, registry);

  for (const name of plan.packages) {
    if (existing.get(name) !== null) continue;
    await registry.publish(archives.get(name), {
      access: "public",
      provenance: true,
      tag: plan.candidateTag,
    });
  }

  await verifyCompleteCohort(plan, archives, registry, source);
  for (const name of plan.packages) {
    await registry.setTag(name, plan.releaseVersion, plan.candidateTag);
  }
  await verifyTagAgreement(plan.packages, plan.candidateTag, plan.releaseVersion, registry);
}

export async function promoteAlpha({ plan, archives, registry, source }) {
  validateOperationInputs(plan, archives, registry, source);
  await verifyCompleteCohort(plan, archives, registry, source);

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
  }
  await removePrereleaseLatest(plan, registry);

  if (!candidateCleanupOnly) {
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

export async function verifyCompleteCohort(plan, archives, registry, source) {
  const states = new Map();
  for (const name of plan.packages) {
    const state = await registry.getVersion(name, plan.releaseVersion);
    if (state === null) throw new Error("registry is missing part of the planned cohort");
    states.set(name, state);
  }
  await validateRegistryStates(states, plan, archives, registry, source);
}

export function validateRegistryVersion(state, archive, version) {
  validateRegistryMetadata(state, archive, version);
  if (state.provenance !== true) throw new Error("registry package has no verified provenance");
}

function validateRegistryMetadata(state, archive, version) {
  assertRecord(state, "registry package metadata");
  if (archive === undefined || state.name !== archive.name || state.version !== version) {
    throw new Error("registry package identity does not match the local archive");
  }
  if (state.integrity !== archive.integrity || !SRI_PATTERN.test(state.integrity)) {
    throw new Error("registry integrity does not match the local archive");
  }
  if (state.access !== "public") throw new Error("registry package is not public");
  if (state.packageMetadata?.engines?.node !== NODE_ENGINES) {
    throw new Error("registry Node engines do not match");
  }
  if (!equalJsonValues(state.packageMetadata, packageMetadataFromManifest(archive.manifest))) {
    throw new Error("registry package metadata does not match the local archive");
  }
}

export async function removePrereleaseLatest(plan, registry) {
  const latestTags = new Map();
  for (const name of plan.packages) {
    latestTags.set(name, await registry.getTag(name, "latest"));
  }
  for (const name of plan.packages) {
    const latest = latestTags.get(name);
    if (typeof latest === "string" && latest.includes("-")) {
      await registry.removeTag(name, "latest");
    }
  }
}

async function validateRegistryStates(states, plan, archives, registry, source) {
  const entries = [];
  for (const name of plan.packages) {
    const state = states.get(name);
    if (state === null || state === undefined) continue;
    validateRegistryMetadata(state, archives.get(name), plan.releaseVersion);
    entries.push({
      name,
      version: plan.releaseVersion,
      integrity: state.integrity,
      attestationUrl: state.attestationUrl,
    });
  }
  if (entries.length === 0) return;
  if (typeof registry.verifyProvenance !== "function") {
    throw new Error("registry cannot verify package provenance");
  }
  const verified = await registry.verifyProvenance(entries, source);
  if (
    !(verified instanceof Set) ||
    verified.size !== entries.length ||
    entries.some(({ name }) => !verified.has(name))
  ) {
    throw new Error("registry provenance verification did not cover the exact cohort");
  }
  for (const { name } of entries) {
    validateRegistryVersion(
      { ...states.get(name), provenance: verified.has(name) },
      archives.get(name),
      plan.releaseVersion,
    );
  }
}

export class NpmRegistry {
  constructor({
    run = runNpm,
    audit = runSignatureAudit,
    certificateIdentity = certificateIdentityFromRawBytes,
  } = {}) {
    this.run = run;
    this.audit = audit;
    this.certificateIdentity = certificateIdentity;
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
    const attestationUrl = validateAttestationDescriptor(metadata.dist.attestations, name, version);
    return {
      name: metadata.name,
      version: metadata.version,
      integrity: metadata.dist.integrity,
      provenance: false,
      attestationUrl,
      access,
      packageMetadata: packageMetadataFromManifest(metadata),
    };
  }

  async verifyProvenance(entries, source) {
    validateProvenanceEntries(entries);
    validateSource(source);
    let result;
    try {
      result = await this.audit(entries);
    } catch {
      throw new Error("registry signature and provenance verification failed");
    }
    return validateAuditResult(result, entries, source, this.certificateIdentity);
  }

  async preflightAccess(packages) {
    assertExactStringSet(packages, PUBLIC_PACKAGES, "npm access preflight packages");
    for (const name of packages) {
      if ((await this.getAccess(name)) !== "public") {
        throw new Error("planned npm package is not public");
      }
    }
    const identity = await this.run(["whoami", "--json"], "authenticating npm token");
    if (typeof identity !== "string" || !NPM_IDENTITY_PATTERN.test(identity)) {
      throw new Error("registry returned an invalid authenticated identity");
    }
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

function validateOperationInputs(plan, archives, registry, source) {
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
  validateSource(source, plan.gitTag);
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

function validateSource(source, expectedTag) {
  assertRecord(source, "release source");
  assertExactFields(source, ["repository", "workflow", "gitRef", "gitCommit"], "release source");
  const tag =
    typeof source.gitRef === "string" && source.gitRef.startsWith("refs/tags/")
      ? source.gitRef.slice("refs/tags/".length)
      : "";
  if (
    source.repository !== SOURCE_REPOSITORY ||
    source.workflow !== PUBLISH_WORKFLOW_PATH ||
    !IMMUTABLE_TAG_PATTERN.test(tag) ||
    (expectedTag !== undefined && tag !== expectedTag) ||
    typeof source.gitCommit !== "string" ||
    !GIT_COMMIT_PATTERN.test(source.gitCommit)
  ) {
    throw new Error("release source does not match the approved tag workflow");
  }
}

function validateAttestationDescriptor(descriptor, name, version) {
  assertRecord(descriptor, "registry provenance descriptor");
  assertExactFields(descriptor, ["url", "provenance"], "registry provenance descriptor");
  assertRecord(descriptor.provenance, "registry provenance declaration");
  assertExactFields(descriptor.provenance, ["predicateType"], "registry provenance declaration");
  const expectedUrl = expectedAttestationUrl(name, version);
  if (descriptor.url !== expectedUrl || descriptor.provenance.predicateType !== SLSA_PREDICATE) {
    throw new Error("registry provenance descriptor is missing or unsafe");
  }
  return expectedUrl;
}

function expectedAttestationUrl(name, version) {
  validatePackageAndVersion(name, version);
  return `${NPM_REGISTRY}/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`;
}

function validateProvenanceEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > PUBLIC_PACKAGES.length) {
    throw new Error("provenance verification requires a bounded package set");
  }
  const names = new Set();
  for (const entry of entries) {
    assertRecord(entry, "provenance package");
    assertExactFields(
      entry,
      ["name", "version", "integrity", "attestationUrl"],
      "provenance package",
    );
    validatePackageAndVersion(entry.name, entry.version);
    if (names.has(entry.name)) throw new Error("provenance package set contains duplicates");
    names.add(entry.name);
    if (
      typeof entry.integrity !== "string" ||
      !SRI_PATTERN.test(entry.integrity) ||
      entry.attestationUrl !== expectedAttestationUrl(entry.name, entry.version)
    ) {
      throw new Error("provenance package metadata is unsafe");
    }
  }
}

function validateAuditResult(result, entries, source, certificateIdentity) {
  assertRecord(result, "npm signature audit result");
  assertExactFields(result, ["invalid", "missing", "verified"], "npm signature audit result");
  if (
    !Array.isArray(result.invalid) ||
    !Array.isArray(result.missing) ||
    result.invalid.length !== 0 ||
    result.missing.length !== 0 ||
    !Array.isArray(result.verified)
  ) {
    throw new Error("npm signature audit did not verify every installed package");
  }

  const expected = new Map(entries.map((entry) => [entry.name, entry]));
  const verified = new Set();
  for (const auditEntry of result.verified) {
    assertRecord(auditEntry, "npm verified package");
    if (typeof auditEntry.name !== "string" || !expected.has(auditEntry.name)) continue;
    if (verified.has(auditEntry.name)) {
      throw new Error("npm signature audit returned duplicate package provenance");
    }
    validateAuditEntry(auditEntry, expected.get(auditEntry.name), source, certificateIdentity);
    verified.add(auditEntry.name);
  }
  if (verified.size !== expected.size) {
    throw new Error("npm signature audit is missing planned package provenance");
  }
  return verified;
}

function validateAuditEntry(entry, expected, source, certificateIdentity) {
  assertExactFields(
    entry,
    ["name", "version", "location", "registry", "attestations", "attestationBundles"],
    "npm verified package",
  );
  if (
    entry.name !== expected.name ||
    entry.version !== expected.version ||
    entry.location !== `node_modules/${expected.name}` ||
    entry.registry !== `${NPM_REGISTRY}/`
  ) {
    throw new Error("npm signature audit package identity does not match the release cohort");
  }
  const attestationUrl = validateAttestationDescriptor(
    entry.attestations,
    expected.name,
    expected.version,
  );
  if (attestationUrl !== expected.attestationUrl || !Array.isArray(entry.attestationBundles)) {
    throw new Error("npm signature audit returned inconsistent attestations");
  }

  const provenanceBundles = [];
  for (const attestation of entry.attestationBundles) {
    assertRecord(attestation, "npm attestation");
    assertExactFields(
      attestation,
      ["predicateType", "bundle", "signedAccessSignatureUrl"],
      "npm attestation",
    );
    if (attestation.signedAccessSignatureUrl !== "") {
      throw new Error("npm attestation returned an unexpected signed-access URL");
    }
    if (attestation.predicateType === SLSA_PREDICATE) provenanceBundles.push(attestation.bundle);
  }
  if (provenanceBundles.length !== 1) {
    throw new Error("npm signature audit did not return one provenance attestation");
  }
  validateProvenanceBundle(provenanceBundles[0], expected, source, certificateIdentity);
}

function validateProvenanceBundle(bundle, expected, source, certificateIdentity) {
  assertRecord(bundle, "Sigstore provenance bundle");
  assertExactFields(
    bundle,
    ["mediaType", "verificationMaterial", "dsseEnvelope"],
    "Sigstore provenance bundle",
  );
  if (bundle.mediaType !== SIGSTORE_BUNDLE_MEDIA_TYPE) {
    throw new Error("Sigstore provenance bundle has an unsupported format");
  }
  assertRecord(bundle.verificationMaterial, "Sigstore verification material");
  assertExactFields(
    bundle.verificationMaterial,
    ["certificate", "tlogEntries", "timestampVerificationData"],
    "Sigstore verification material",
  );
  const { certificate, tlogEntries, timestampVerificationData } = bundle.verificationMaterial;
  assertRecord(certificate, "Sigstore signing certificate");
  assertExactFields(certificate, ["rawBytes"], "Sigstore signing certificate");
  decodeBase64(certificate.rawBytes, "Sigstore signing certificate");
  if (!Array.isArray(tlogEntries) || tlogEntries.length === 0) {
    throw new Error("Sigstore provenance bundle has no transparency log entry");
  }
  assertRecord(timestampVerificationData, "Sigstore timestamp verification data");

  const expectedIdentity = `${source.repository}/${source.workflow}@${source.gitRef}`;
  let actualIdentity;
  try {
    actualIdentity = certificateIdentity(certificate.rawBytes);
  } catch {
    throw new Error("Sigstore provenance signing certificate is invalid");
  }
  if (actualIdentity !== expectedIdentity) {
    throw new Error("Sigstore provenance certificate identity does not match the release workflow");
  }

  assertRecord(bundle.dsseEnvelope, "Sigstore DSSE envelope");
  assertExactFields(
    bundle.dsseEnvelope,
    ["payload", "payloadType", "signatures"],
    "Sigstore DSSE envelope",
  );
  if (
    bundle.dsseEnvelope.payloadType !== INTOTO_PAYLOAD ||
    !Array.isArray(bundle.dsseEnvelope.signatures) ||
    bundle.dsseEnvelope.signatures.length !== 1
  ) {
    throw new Error("Sigstore DSSE envelope is malformed");
  }
  const [signature] = bundle.dsseEnvelope.signatures;
  assertRecord(signature, "Sigstore DSSE signature");
  assertExactFields(signature, ["sig", "keyid"], "Sigstore DSSE signature");
  if (signature.keyid !== "") throw new Error("Sigstore DSSE signature is not keyless");
  decodeBase64(signature.sig, "Sigstore DSSE signature");

  const payload = decodeBase64(bundle.dsseEnvelope.payload, "Sigstore DSSE payload").toString(
    "utf8",
  );
  validateProvenanceStatement(
    parseStrictJson(payload, "Sigstore provenance statement"),
    expected,
    source,
  );
}

function validateProvenanceStatement(statement, expected, source) {
  assertRecord(statement, "SLSA provenance statement");
  assertExactFields(
    statement,
    ["_type", "subject", "predicateType", "predicate"],
    "SLSA provenance statement",
  );
  if (
    statement._type !== INTOTO_STATEMENT ||
    statement.predicateType !== SLSA_PREDICATE ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1
  ) {
    throw new Error("SLSA provenance statement is malformed");
  }
  const [subject] = statement.subject;
  assertRecord(subject, "SLSA provenance subject");
  assertExactFields(subject, ["name", "digest"], "SLSA provenance subject");
  assertRecord(subject.digest, "SLSA provenance subject digest");
  assertExactFields(subject.digest, ["sha512"], "SLSA provenance subject digest");
  if (
    subject.name !== packagePurl(expected.name, expected.version) ||
    subject.digest.sha512 !== integrityHexDigest(expected.integrity)
  ) {
    throw new Error("SLSA provenance subject does not match the package bytes");
  }

  assertRecord(statement.predicate, "SLSA provenance predicate");
  assertExactFields(
    statement.predicate,
    ["buildDefinition", "runDetails"],
    "SLSA provenance predicate",
  );
  validateBuildDefinition(statement.predicate.buildDefinition, source);
  validateRunDetails(statement.predicate.runDetails);
}

function validateBuildDefinition(definition, source) {
  assertRecord(definition, "SLSA build definition");
  assertExactFields(
    definition,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    "SLSA build definition",
  );
  if (definition.buildType !== GITHUB_BUILD_TYPE) {
    throw new Error("SLSA provenance has an unsupported build type");
  }
  assertRecord(definition.externalParameters, "SLSA external parameters");
  assertExactFields(definition.externalParameters, ["workflow"], "SLSA external parameters");
  const { workflow } = definition.externalParameters;
  assertRecord(workflow, "SLSA workflow parameters");
  assertExactFields(workflow, ["ref", "repository", "path"], "SLSA workflow parameters");
  if (
    workflow.ref !== source.gitRef ||
    workflow.repository !== source.repository ||
    workflow.path !== source.workflow
  ) {
    throw new Error("SLSA provenance source workflow does not match the release source");
  }

  assertRecord(definition.internalParameters, "SLSA internal parameters");
  assertExactFields(definition.internalParameters, ["github"], "SLSA internal parameters");
  const github = definition.internalParameters.github;
  assertRecord(github, "SLSA GitHub parameters");
  assertExactFields(
    github,
    ["event_name", "repository_id", "repository_owner_id"],
    "SLSA GitHub parameters",
  );
  if (
    !["push", "workflow_dispatch"].includes(github.event_name) ||
    typeof github.repository_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(github.repository_id) ||
    typeof github.repository_owner_id !== "string" ||
    !/^[1-9][0-9]*$/u.test(github.repository_owner_id)
  ) {
    throw new Error("SLSA provenance GitHub parameters are malformed");
  }

  if (
    !Array.isArray(definition.resolvedDependencies) ||
    definition.resolvedDependencies.length !== 1
  ) {
    throw new Error("SLSA provenance resolved source is malformed");
  }
  const [resolved] = definition.resolvedDependencies;
  assertRecord(resolved, "SLSA resolved source");
  assertExactFields(resolved, ["uri", "digest"], "SLSA resolved source");
  assertRecord(resolved.digest, "SLSA resolved source digest");
  assertExactFields(resolved.digest, ["gitCommit"], "SLSA resolved source digest");
  if (
    resolved.uri !== `git+${source.repository}@${source.gitRef}` ||
    resolved.digest.gitCommit !== source.gitCommit
  ) {
    throw new Error("SLSA provenance commit does not match the release source");
  }
}

function validateRunDetails(details) {
  assertRecord(details, "SLSA run details");
  assertExactFields(details, ["builder", "metadata"], "SLSA run details");
  assertRecord(details.builder, "SLSA builder");
  assertExactFields(details.builder, ["id"], "SLSA builder");
  assertRecord(details.metadata, "SLSA run metadata");
  assertExactFields(details.metadata, ["invocationId"], "SLSA run metadata");
  if (
    details.builder.id !== GITHUB_BUILDER ||
    typeof details.metadata.invocationId !== "string" ||
    !/^https:\/\/github\.com\/subtopik\/topik\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(
      details.metadata.invocationId,
    )
  ) {
    throw new Error("SLSA provenance run identity is malformed");
  }
}

function packagePurl(name, version) {
  const slash = name.indexOf("/");
  return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${version}`;
}

function integrityHexDigest(integrity) {
  const encoded = integrity.slice("sha512-".length);
  return decodeBase64(encoded, "package integrity").toString("hex");
}

function decodeBase64(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

function certificateIdentityFromRawBytes(rawBytes) {
  const certificate = new X509Certificate(decodeBase64(rawBytes, "Sigstore signing certificate"));
  const match = /^URI:(https:\/\/github\.com\/[^,]+)$/u.exec(certificate.subjectAltName);
  if (match === null) throw new Error("certificate has no single GitHub workflow identity");
  return match[1];
}

export async function runSignatureAudit(entries, { run = runFile } = {}) {
  validateProvenanceEntries(entries);
  const root = await mkdtemp(join(tmpdir(), "topik-provenance-"));
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "topik-provenance-verification",
          version: "0.0.0",
          private: true,
          dependencies: Object.fromEntries(entries.map(({ name, version }) => [name, version])),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const userConfig = join(root, ".npmrc");
    await writeFile(userConfig, `registry=${NPM_REGISTRY}/\nalways-auth=false\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const env = {
      ...process.env,
      NO_UPDATE_NOTIFIER: "1",
      npm_config_registry: NPM_REGISTRY,
      npm_config_userconfig: userConfig,
    };
    delete env.NODE_AUTH_TOKEN;
    delete env.NPM_TOKEN;
    const options = { cwd: root, env, maxBuffer: 16 * 1024 * 1024 };
    await run(
      "npx",
      [
        "-y",
        `npm@${NPM_CLI_VERSION}`,
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry",
        NPM_REGISTRY,
      ],
      options,
    );
    const { stdout } = await run(
      "npx",
      [
        "-y",
        `npm@${NPM_CLI_VERSION}`,
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        "--registry",
        NPM_REGISTRY,
      ],
      options,
    );
    return parseStrictJson(stdout, "npm signature audit response");
  } catch {
    throw new Error("registry signature and provenance verification failed");
  } finally {
    await rm(root, { recursive: true, force: true });
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
