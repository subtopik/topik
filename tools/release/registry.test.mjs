import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadReleaseContext } from "./plan.mjs";
import {
  NpmRegistry,
  packageMetadataFromManifest,
  promoteAlpha,
  publishCandidate,
  runSignatureAudit,
  validateRegistryVersion,
} from "./registry.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const context = await loadReleaseContext(workspaceRoot);
const { plan } = context;
const archives = makeArchives(context);
const source = {
  repository: "https://github.com/subtopik/topik",
  workflow: ".github/workflows/publish.yaml",
  gitRef: `refs/tags/${plan.gitTag}`,
  gitCommit: "a".repeat(40),
};

void test("valid initial publication preflights all versions and publishes one candidate cohort", async () => {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages) registry.tags.get(name).latest = "0.1.0-alpha.4";

  await publishCandidate({ mode: "initial", plan, archives, registry, source });

  assert.equal(registry.events.filter((event) => event.startsWith("publish:")).length, 6);
  assert.equal(registry.accessPreflightCalls, 1);
  for (const name of plan.packages) {
    assert.equal(registry.tags.get(name).candidate, plan.releaseVersion);
    assert.equal(registry.tags.get(name).latest, undefined);
    assert.equal(registry.tags.get(name).alpha, undefined);
  }
});

void test("initial publication aborts before any publish when even a late package version exists", async () => {
  const registry = new FakeRegistry(archives);
  const last = plan.packages.at(-1);
  registry.versions.set(last, registryState(archives.get(last)));

  await assert.rejects(
    publishCandidate({ mode: "initial", plan, archives, registry, source }),
    /existing planned version/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("publish:")),
    false,
  );
});

void test("initial publication rejects pre-existing candidate ownership before any mutation", async () => {
  for (const candidate of ["0.1.0-alpha.4", plan.releaseVersion]) {
    const registry = new FakeRegistry(archives);
    registry.tags.get(plan.packages.at(-1)).candidate = candidate;

    await assert.rejects(
      publishCandidate({ mode: "initial", plan, archives, registry, source }),
      /candidate/u,
    );
    assert.equal(registry.events.some(isRegistryMutation), false);
  }
});

void test("recovery rejects foreign candidate ownership before any mutation", async () => {
  const registry = new FakeRegistry(archives);
  registry.tags.get(plan.packages[2]).candidate = "0.1.0-alpha.4";
  registry.tags.get(plan.packages[4]).candidate = plan.releaseVersion;

  await assert.rejects(
    publishCandidate({ mode: "recovery", plan, archives, registry, source }),
    /candidate/u,
  );
  assert.equal(registry.events.some(isRegistryMutation), false);
});

void test("publication authentication failure aborts both modes before registry mutation", async () => {
  for (const mode of ["initial", "recovery"]) {
    const calls = [];
    const registry = new NpmRegistry({
      run: async (args) => {
        calls.push(args);
        if (args[0] === "view" && args[2] === "versions") return [];
        if (args[0] === "view" && args[2] === "dist-tags") return {};
        if (args[0] === "access") throw new Error("injected authentication failure");
        throw new Error("unexpected npm command");
      },
    });

    await assert.rejects(
      publishCandidate({ mode, plan, archives, registry, source }),
      /injected authentication failure/u,
    );
    assert.deepEqual(calls.at(-1), ["access", "get", "status", plan.packages[0], "--json"]);
    assert.equal(calls.some(isNpmMutation), false);
  }
});

void test("recovery publishes only missing packages and a retry completes a partial publish", async () => {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages.slice(0, 2)) {
    registry.versions.set(name, registryState(archives.get(name)));
    registry.tags.get(name).candidate = plan.releaseVersion;
  }
  registry.failPublishAt = 3;

  await assert.rejects(
    publishCandidate({ mode: "recovery", plan, archives, registry, source }),
    /injected publish failure/u,
  );
  assert.equal(registry.versions.size, 4);

  registry.failPublishAt = null;
  registry.publishCalls = 0;
  await publishCandidate({ mode: "recovery", plan, archives, registry, source });
  assert.equal(registry.versions.size, 6);
  assert.equal(registry.events.filter((event) => event.startsWith("publish:")).length, 4);
  for (const name of plan.packages) {
    assert.equal(registry.tags.get(name).candidate, plan.releaseVersion);
  }
});

void test("recovery rejects mixed integrity or source metadata before publishing a missing package", async () => {
  const registry = new FakeRegistry(archives);
  const [first] = plan.packages;
  registry.versions.set(first, {
    ...registryState(archives.get(first)),
    integrity: `sha512-${Buffer.from("different source bytes").toString("base64")}`,
  });

  await assert.rejects(
    publishCandidate({ mode: "recovery", plan, archives, registry, source }),
    /integrity/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("publish:")),
    false,
  );
});

void test("latest prerelease cleanup completes before the first publication attempt", async () => {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages) registry.tags.get(name).latest = "0.1.0-alpha.4";
  registry.failPublishAt = 1;

  await assert.rejects(
    publishCandidate({ mode: "initial", plan, archives, registry, source }),
    /injected publish failure/u,
  );
  for (const name of plan.packages) assert.equal(registry.tags.get(name).latest, undefined);
});

void test("provenance failure aborts recovery before latest cleanup or publication", async () => {
  const registry = new FakeRegistry(archives);
  const [first] = plan.packages;
  registry.versions.set(first, registryState(archives.get(first)));
  registry.tags.get(first).candidate = plan.releaseVersion;
  for (const name of plan.packages) registry.tags.get(name).latest = "0.1.0-alpha.4";
  registry.provenanceFailure = true;

  await assert.rejects(
    publishCandidate({ mode: "recovery", plan, archives, registry, source }),
    /injected provenance failure/u,
  );
  assert.equal(registry.events.some(isRegistryMutation), false);
  for (const name of plan.packages) {
    assert.equal(registry.tags.get(name).latest, "0.1.0-alpha.4");
  }
});

void test("provenance and metadata mismatches fail registry verification", () => {
  const archive = archives.get(plan.packages[0]);
  assert.throws(
    () =>
      validateRegistryVersion(
        { ...registryState(archive), provenance: false },
        archive,
        plan.releaseVersion,
      ),
    /provenance/u,
  );
  assert.throws(
    () =>
      validateRegistryVersion(
        {
          ...registryState(archive),
          packageMetadata: {
            ...registryState(archive).packageMetadata,
            dependencies: { unexpected: "1.0.0" },
          },
        },
        archive,
        plan.releaseVersion,
      ),
    /package metadata/u,
  );
});

void test("npm-view metadata without the source files field verifies successfully", async () => {
  const archive = archives.get(plan.packages[0]);
  const npmViewMetadata = {
    ...clone(archive.manifest),
    dist: {
      integrity: archive.integrity,
      attestations: {
        url: attestationUrl(archive.name, archive.version),
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  delete npmViewMetadata.files;
  const responses = [[plan.releaseVersion], npmViewMetadata, { [archive.name]: "public" }];
  const registry = new NpmRegistry({
    run: async () => responses.shift(),
    audit: async (entries) => provenanceAudit(entries),
    certificateIdentity: () => sourceIdentity(),
  });
  const state = await registry.getVersion(archive.name, archive.version);
  const verified = await registry.verifyProvenance([provenanceEntry(state)], source);
  validateRegistryVersion(
    { ...state, provenance: verified.has(archive.name) },
    archive,
    archive.version,
  );
  assert.equal(Object.hasOwn(state.packageMetadata, "files"), false);
  assert.deepEqual(archive.manifest.files, ["dist"]);
  assert.equal(responses.length, 0);
});

void test("an attestation descriptor alone is not verified provenance", async () => {
  const archive = archives.get(plan.packages[0]);
  const metadata = {
    ...clone(archive.manifest),
    dist: {
      integrity: archive.integrity,
      attestations: {
        url: `https://registry.npmjs.org/-/npm/v1/attestations/${archive.name.replace("/", "%2f")}@${archive.version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  const responses = [[plan.releaseVersion], metadata, "public"];
  const registry = new NpmRegistry({ run: async () => responses.shift() });

  const state = await registry.getVersion(archive.name, archive.version);

  assert.equal(state.provenance, false);
});

void test("provenance audit binds package bytes, repository, workflow, ref, SHA, and certificate", async () => {
  const archive = archives.get(plan.packages[0]);
  const entry = provenanceEntryFromArchive(archive);
  const registry = new NpmRegistry({
    audit: async (entries) => provenanceAudit(entries),
    certificateIdentity: () => sourceIdentity(),
  });

  assert.deepEqual(await registry.verifyProvenance([entry], source), new Set([archive.name]));

  const cases = [
    [
      "repository",
      (statement) =>
        (statement.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/example/other"),
      /source workflow/u,
    ],
    [
      "workflow",
      (statement) =>
        (statement.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yaml"),
      /source workflow/u,
    ],
    [
      "ref",
      (statement) =>
        (statement.predicate.buildDefinition.externalParameters.workflow.ref =
          "refs/tags/v0.1.0-alpha.4"),
      /source workflow/u,
    ],
    [
      "SHA",
      (statement) =>
        (statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(
          40,
        )),
      /commit/u,
    ],
    [
      "package",
      (statement) => (statement.subject[0].name = "pkg:npm/%40topik/other@0.1.0-alpha.5"),
      /subject/u,
    ],
    [
      "integrity",
      (statement) => (statement.subject[0].digest.sha512 = "0".repeat(128)),
      /subject/u,
    ],
  ];
  for (const [, mutate, expectedError] of cases) {
    const mismatched = new NpmRegistry({
      audit: async (entries) => provenanceAudit(entries, { mutateStatement: mutate }),
      certificateIdentity: () => sourceIdentity(),
    });
    await assert.rejects(mismatched.verifyProvenance([entry], source), expectedError);
  }

  const wrongCertificate = new NpmRegistry({
    audit: async (entries) => provenanceAudit(entries),
    certificateIdentity: () =>
      "https://github.com/subtopik/topik/.github/workflows/other.yaml@refs/tags/v0.1.0-alpha.5",
  });
  await assert.rejects(wrongCertificate.verifyProvenance([entry], source), /certificate identity/u);
});

void test("provenance verification rejects missing, malformed, or signature-failed evidence", async () => {
  const entry = provenanceEntryFromArchive(archives.get(plan.packages[0]));
  const missing = new NpmRegistry({
    audit: async () => ({ invalid: [], missing: [], verified: [] }),
    certificateIdentity: () => sourceIdentity(),
  });
  await assert.rejects(missing.verifyProvenance([entry], source), /missing planned/u);

  const malformedAudit = provenanceAudit([entry]);
  malformedAudit.verified[0].attestationBundles[0].bundle.dsseEnvelope.payload = Buffer.from(
    '{"_type":"first","_type":"second"}',
  ).toString("base64");
  const malformed = new NpmRegistry({
    audit: async () => malformedAudit,
    certificateIdentity: () => sourceIdentity(),
  });
  await assert.rejects(malformed.verifyProvenance([entry], source), /duplicate object key/u);

  const signatureFailure = new NpmRegistry({
    audit: async () => {
      throw new Error("untrusted signature");
    },
  });
  await assert.rejects(
    signatureFailure.verifyProvenance([entry], source),
    /signature and provenance verification failed/u,
  );

  const invalidCertificate = new NpmRegistry({
    audit: async (entries) => provenanceAudit(entries),
  });
  await assert.rejects(
    invalidCertificate.verifyProvenance([entry], source),
    /signing certificate is invalid/u,
  );
});

void test("npm provenance descriptors are restricted to the exact registry endpoint", async () => {
  const archive = archives.get(plan.packages[0]);
  const metadata = {
    ...clone(archive.manifest),
    dist: {
      integrity: archive.integrity,
      attestations: {
        url: `https://example.invalid/-/npm/v1/attestations/${archive.name}@${archive.version}`,
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  const responses = [[plan.releaseVersion], metadata, "public"];
  const registry = new NpmRegistry({ run: async () => responses.shift() });

  await assert.rejects(registry.getVersion(archive.name, archive.version), /missing or unsafe/u);
});

void test("signature verification uses pinned npm in an isolated exact-version consumer", async () => {
  const entry = provenanceEntryFromArchive(archives.get(plan.packages[0]));
  const calls = [];
  let temporaryRoot;
  const result = await runSignatureAudit([entry], {
    run: async (file, arguments_, options) => {
      calls.push({ file, arguments_, options });
      temporaryRoot = options.cwd;
      if (arguments_.includes("install")) {
        const manifest = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
        assert.deepEqual(manifest.dependencies, { [entry.name]: entry.version });
        return { stdout: "" };
      }
      return { stdout: '{"invalid":[],"missing":[],"verified":[]}' };
    },
  });

  assert.deepEqual({ ...result }, { invalid: [], missing: [], verified: [] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, "npx");
    assert.deepEqual(call.arguments_.slice(0, 2), ["-y", "npm@11.13.0"]);
    assert.equal(Object.hasOwn(call.options.env, "NODE_AUTH_TOKEN"), false);
    assert.equal(Object.hasOwn(call.options.env, "NPM_TOKEN"), false);
  }
  assert.deepEqual(calls[1].arguments_.slice(2, 6), [
    "audit",
    "signatures",
    "--json",
    "--include-attestations",
  ]);
  await assert.rejects(readFile(join(temporaryRoot, "package.json"), "utf8"), /ENOENT/u);
});

void test("promotion rejects stale or mixed candidate tags before changing alpha", async () => {
  const registry = completeCandidateRegistry();
  registry.tags.get(plan.packages[2]).candidate = "0.1.0-alpha.4";
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";

  await assert.rejects(
    promoteAlpha({ plan, archives, registry, source }),
    /stale, missing, or mixed/u,
  );
  assert.equal(registry.events.some(isTagMutation), false);
});

void test("failed old-lane removal adds no new tags and retries forward", async () => {
  const registry = completeCandidateRegistry();
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";
  registry.failAlphaRemovalAt = 3;

  await assert.rejects(
    promoteAlpha({ plan, archives, registry, source }),
    /injected alpha removal failure/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("set:alpha:")),
    false,
  );

  registry.failAlphaRemovalAt = null;
  registry.alphaRemovalCalls = 0;
  await promoteAlpha({ plan, archives, registry, source });
  assertPromoted(registry);
});

void test("partial new-lane addition remains fail-closed and retry rolls forward", async () => {
  const registry = completeCandidateRegistry();
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";
  registry.failAlphaSetAt = 3;

  await assert.rejects(
    promoteAlpha({ plan, archives, registry, source }),
    /injected alpha set failure/u,
  );
  assert.deepEqual(
    plan.packages.map((name) => registry.tags.get(name).alpha ?? null),
    [plan.releaseVersion, plan.releaseVersion, null, null, null, null],
  );
  assert.equal(
    plan.packages.some((name) => registry.tags.get(name).alpha === "0.1.0-alpha.4"),
    false,
  );

  registry.failAlphaSetAt = null;
  registry.alphaSetCalls = 0;
  await promoteAlpha({ plan, archives, registry, source });
  assertPromoted(registry);
});

void test("candidate cleanup can be retried only after a complete alpha cohort", async () => {
  const registry = completeCandidateRegistry();
  registry.failCandidateRemovalAt = 3;

  await assert.rejects(
    promoteAlpha({ plan, archives, registry, source }),
    /candidate removal failure/u,
  );
  for (const name of plan.packages)
    assert.equal(registry.tags.get(name).alpha, plan.releaseVersion);

  registry.failCandidateRemovalAt = null;
  registry.candidateRemovalCalls = 0;
  await promoteAlpha({ plan, archives, registry, source });
  assertPromoted(registry);
});

void test("promotion cleanup-only retry still removes prerelease latest", async () => {
  const registry = completeCandidateRegistry();
  for (const name of plan.packages) {
    registry.tags.get(name).alpha = plan.releaseVersion;
    registry.tags.get(name).latest = "0.1.0-alpha.4";
  }

  await promoteAlpha({ plan, archives, registry, source });

  for (const name of plan.packages) assert.equal(registry.tags.get(name).latest, undefined);
  assertPromoted(registry);
});

void test("npm adapter rejects arbitrary package and latest-tag operations before invoking npm", async () => {
  let calls = 0;
  const registry = new NpmRegistry({
    run: async () => {
      calls++;
      return null;
    },
  });
  await assert.rejects(registry.setTag("--workspace", plan.releaseVersion, "alpha"), /unsafe/u);
  await assert.rejects(
    registry.setTag(plan.packages[0], plan.releaseVersion, "latest"),
    /never sets/u,
  );
  assert.equal(calls, 0);
});

void test("npm access preflight authenticates against every planned public package", async () => {
  const calls = [];
  const registry = new NpmRegistry({
    run: async (args) => {
      calls.push(args);
      return "public";
    },
  });

  await registry.preflightAccess(plan.packages);

  assert.deepEqual(
    calls,
    plan.packages.map((name) => ["access", "get", "status", name, "--json"]),
  );

  const nonPublic = new NpmRegistry({
    run: async (args) => (args[3] === plan.packages.at(-1) ? "private" : "public"),
  });
  await assert.rejects(nonPublic.preflightAccess(plan.packages), /not public/u);
});

class FakeRegistry {
  constructor(archiveSet) {
    this.archives = archiveSet;
    this.versions = new Map();
    this.tags = new Map(plan.packages.map((name) => [name, Object.create(null)]));
    this.events = [];
    this.publishCalls = 0;
    this.alphaRemovalCalls = 0;
    this.alphaSetCalls = 0;
    this.candidateRemovalCalls = 0;
    this.failPublishAt = null;
    this.failAlphaRemovalAt = null;
    this.failAlphaSetAt = null;
    this.failCandidateRemovalAt = null;
    this.provenanceFailure = false;
    this.accessPreflightCalls = 0;
  }

  async getVersion(name) {
    return this.versions.get(name) ?? null;
  }

  async getTag(name, tag) {
    return this.tags.get(name)[tag] ?? null;
  }

  async verifyProvenance(entries) {
    if (this.provenanceFailure) throw new Error("injected provenance failure");
    return new Set(entries.map(({ name }) => name));
  }

  async preflightAccess(packages) {
    this.accessPreflightCalls++;
    assert.deepEqual(packages, plan.packages);
  }

  async publish(archive, options) {
    this.publishCalls++;
    if (this.publishCalls === this.failPublishAt) throw new Error("injected publish failure");
    assert.deepEqual(options, { access: "public", provenance: true, tag: "candidate" });
    this.events.push(`publish:${archive.name}`);
    this.versions.set(archive.name, registryState(archive));
    this.tags.get(archive.name).candidate = archive.version;
  }

  async setTag(name, version, tag) {
    if (tag === "alpha") {
      this.alphaSetCalls++;
      if (this.alphaSetCalls === this.failAlphaSetAt) throw new Error("injected alpha set failure");
    }
    this.events.push(`set:${tag}:${name}`);
    this.tags.get(name)[tag] = version;
  }

  async removeTag(name, tag) {
    if (tag === "alpha") {
      this.alphaRemovalCalls++;
      if (this.alphaRemovalCalls === this.failAlphaRemovalAt) {
        throw new Error("injected alpha removal failure");
      }
    }
    if (tag === "candidate") {
      this.candidateRemovalCalls++;
      if (this.candidateRemovalCalls === this.failCandidateRemovalAt) {
        throw new Error("injected candidate removal failure");
      }
    }
    this.events.push(`remove:${tag}:${name}`);
    delete this.tags.get(name)[tag];
  }
}

function makeArchives(releaseContext) {
  return new Map(
    releaseContext.plan.packages.map((name) => {
      const manifest = clone(releaseContext.manifests.get(name));
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
          if (dependency.startsWith("@topik/") && version.startsWith("workspace:")) {
            manifest[section][dependency] = version.slice("workspace:".length);
          }
        }
      }
      return [
        name,
        {
          name,
          version: releaseContext.plan.releaseVersion,
          integrity: `sha512-${Buffer.from(`archive:${name}`).toString("base64")}`,
          manifest,
          path: `/fixture/${name.slice(1).replace("/", "-")}.tgz`,
        },
      ];
    }),
  );
}

function registryState(archive) {
  return {
    name: archive.name,
    version: archive.version,
    integrity: archive.integrity,
    provenance: true,
    access: "public",
    packageMetadata: packageMetadataFromManifest(archive.manifest),
  };
}

function provenanceEntry(state) {
  return {
    name: state.name,
    version: state.version,
    integrity: state.integrity,
    attestationUrl: state.attestationUrl,
  };
}

function provenanceEntryFromArchive(archive) {
  return {
    name: archive.name,
    version: archive.version,
    integrity: archive.integrity,
    attestationUrl: attestationUrl(archive.name, archive.version),
  };
}

function provenanceAudit(entries, { mutateStatement } = {}) {
  return {
    invalid: [],
    missing: [],
    verified: entries.map((entry) => {
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [
          {
            name: packagePurl(entry.name, entry.version),
            digest: { sha512: integrityHexDigest(entry.integrity) },
          },
        ],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            externalParameters: {
              workflow: {
                ref: source.gitRef,
                repository: source.repository,
                path: source.workflow,
              },
            },
            internalParameters: {
              github: {
                event_name: "push",
                repository_id: "123456",
                repository_owner_id: "654321",
              },
            },
            resolvedDependencies: [
              {
                uri: `git+${source.repository}@${source.gitRef}`,
                digest: { gitCommit: source.gitCommit },
              },
            ],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
            metadata: {
              invocationId: `${source.repository}/actions/runs/123/attempts/1`,
            },
          },
        },
      };
      mutateStatement?.(statement, entry);
      return {
        name: entry.name,
        version: entry.version,
        location: `node_modules/${entry.name}`,
        registry: "https://registry.npmjs.org/",
        attestations: {
          url: entry.attestationUrl,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
        attestationBundles: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            signedAccessSignatureUrl: "",
            bundle: {
              mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
              verificationMaterial: {
                certificate: { rawBytes: Buffer.from("fixture certificate").toString("base64") },
                tlogEntries: [{}],
                timestampVerificationData: {},
              },
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
                payloadType: "application/vnd.in-toto+json",
                signatures: [
                  { sig: Buffer.from("fixture signature").toString("base64"), keyid: "" },
                ],
              },
            },
          },
        ],
      };
    }),
  };
}

function attestationUrl(name, version) {
  return `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`;
}

function packagePurl(name, version) {
  const slash = name.indexOf("/");
  return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${version}`;
}

function integrityHexDigest(integrity) {
  return Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex");
}

function sourceIdentity() {
  return `${source.repository}/${source.workflow}@${source.gitRef}`;
}

function completeCandidateRegistry() {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages) {
    registry.versions.set(name, registryState(archives.get(name)));
    registry.tags.get(name).candidate = plan.releaseVersion;
  }
  return registry;
}

function assertPromoted(registry) {
  for (const name of plan.packages) {
    assert.equal(registry.tags.get(name).alpha, plan.releaseVersion);
    assert.equal(registry.tags.get(name).candidate, undefined);
  }
}

function isTagMutation(event) {
  return event.startsWith("set:") || event.startsWith("remove:");
}

function isRegistryMutation(event) {
  return event.startsWith("publish:") || isTagMutation(event);
}

function isNpmMutation(args) {
  return args[0] === "publish" || args[0] === "dist-tag";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
