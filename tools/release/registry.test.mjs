import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadReleaseContext } from "./plan.mjs";
import {
  NpmRegistry,
  packageMetadataFromManifest,
  promoteAlpha,
  publishCandidate,
  validateRegistryVersion,
} from "./registry.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const context = await loadReleaseContext(workspaceRoot);
const { plan } = context;
const archives = makeArchives(context);

void test("valid initial publication preflights all versions and publishes one candidate cohort", async () => {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages) registry.tags.get(name).latest = "0.1.0-alpha.4";

  await publishCandidate({ mode: "initial", plan, archives, registry });

  assert.equal(registry.events.filter((event) => event.startsWith("publish:")).length, 6);
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
    publishCandidate({ mode: "initial", plan, archives, registry }),
    /existing planned version/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("publish:")),
    false,
  );
});

void test("recovery publishes only missing packages and a retry completes a partial publish", async () => {
  const registry = new FakeRegistry(archives);
  for (const name of plan.packages.slice(0, 2)) {
    registry.versions.set(name, registryState(archives.get(name)));
    registry.tags.get(name).candidate = plan.releaseVersion;
  }
  registry.failPublishAt = 3;

  await assert.rejects(
    publishCandidate({ mode: "recovery", plan, archives, registry }),
    /injected publish failure/u,
  );
  assert.equal(registry.versions.size, 4);

  registry.failPublishAt = null;
  registry.publishCalls = 0;
  await publishCandidate({ mode: "recovery", plan, archives, registry });
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
    publishCandidate({ mode: "recovery", plan, archives, registry }),
    /integrity/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("publish:")),
    false,
  );
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
        url: "https://registry.npmjs.org/-/npm/v1/attestations/fixture",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    },
  };
  delete npmViewMetadata.files;
  const responses = [[plan.releaseVersion], npmViewMetadata, { [archive.name]: "public" }];
  const registry = new NpmRegistry({ run: async () => responses.shift() });
  const state = await registry.getVersion(archive.name, archive.version);
  validateRegistryVersion(state, archive, archive.version);
  assert.equal(Object.hasOwn(state.packageMetadata, "files"), false);
  assert.deepEqual(archive.manifest.files, ["dist"]);
  assert.equal(responses.length, 0);
});

void test("promotion rejects stale or mixed candidate tags before changing alpha", async () => {
  const registry = completeCandidateRegistry();
  registry.tags.get(plan.packages[2]).candidate = "0.1.0-alpha.4";
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";

  await assert.rejects(promoteAlpha({ plan, archives, registry }), /stale, missing, or mixed/u);
  assert.equal(registry.events.some(isTagMutation), false);
});

void test("failed old-lane removal adds no new tags and retries forward", async () => {
  const registry = completeCandidateRegistry();
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";
  registry.failAlphaRemovalAt = 3;

  await assert.rejects(
    promoteAlpha({ plan, archives, registry }),
    /injected alpha removal failure/u,
  );
  assert.equal(
    registry.events.some((event) => event.startsWith("set:alpha:")),
    false,
  );

  registry.failAlphaRemovalAt = null;
  registry.alphaRemovalCalls = 0;
  await promoteAlpha({ plan, archives, registry });
  assertPromoted(registry);
});

void test("partial new-lane addition remains fail-closed and retry rolls forward", async () => {
  const registry = completeCandidateRegistry();
  for (const name of plan.packages) registry.tags.get(name).alpha = "0.1.0-alpha.4";
  registry.failAlphaSetAt = 3;

  await assert.rejects(promoteAlpha({ plan, archives, registry }), /injected alpha set failure/u);
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
  await promoteAlpha({ plan, archives, registry });
  assertPromoted(registry);
});

void test("candidate cleanup can be retried only after a complete alpha cohort", async () => {
  const registry = completeCandidateRegistry();
  registry.failCandidateRemovalAt = 3;

  await assert.rejects(promoteAlpha({ plan, archives, registry }), /candidate removal failure/u);
  for (const name of plan.packages)
    assert.equal(registry.tags.get(name).alpha, plan.releaseVersion);

  registry.failCandidateRemovalAt = null;
  registry.candidateRemovalCalls = 0;
  await promoteAlpha({ plan, archives, registry });
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
  }

  async getVersion(name) {
    return this.versions.get(name) ?? null;
  }

  async getTag(name, tag) {
    return this.tags.get(name)[tag] ?? null;
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
