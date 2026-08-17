import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parseCliArguments, publicReleaseError } from "./cli.mjs";
import { verifyGitTag } from "./git-tag.mjs";
import {
  loadReleaseContext,
  loadReleasePlan,
  validatePlanObject,
  validatePublicManifest,
} from "./plan.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

void test("the checked-in alpha plan and public manifests form one exact cohort", async () => {
  const { plan, manifests } = await loadReleaseContext(workspaceRoot);
  assert.equal(plan.releaseVersion, "0.1.0-alpha.5");
  assert.deepEqual(
    plan.featureFloors.map(({ feature }) => feature),
    ["automatic-asset-identity", "fail-closed-invalid-and-unsupported-content"],
  );
  assert.equal(manifests.size, 6);
  assert.equal(manifests.has("@topik/astro"), false);
  for (const manifest of manifests.values()) {
    assert.equal(manifest.version, plan.releaseVersion);
    assert.equal(manifest.engines.node, "^22.12.0 || ^24.0.0");
  }
});

void test("strict JSON rejects duplicate keys instead of accepting the last value", () => {
  assert.throws(
    () => parseStrictJson('{"planSchemaVersion":1,"planSchemaVersion":2}', "fixture"),
    /duplicate object key/u,
  );
});

void test("plan parsing rejects extra fields, duplicate membership, and package drift", async () => {
  const valid = await loadReleasePlan(workspaceRoot);
  const withExtra = clone(valid);
  withExtra.notes = "not part of the plan schema";
  assert.throws(() => validatePlanObject(withExtra), /missing or unexpected fields/u);

  const duplicate = clone(valid);
  duplicate.packages[5] = duplicate.packages[0];
  assert.throws(() => validatePlanObject(duplicate), /duplicates/u);

  const missing = clone(valid);
  missing.packages.pop();
  assert.throws(() => validatePlanObject(missing), /supported set/u);

  const inconsistent = clone(valid);
  inconsistent.gitTag = "v0.1.0-alpha.6";
  assert.throws(() => validatePlanObject(inconsistent), /disagree/u);

  const unsupportedFeature = clone(valid);
  unsupportedFeature.featureFloors[0].feature = "portable-resources";
  assert.throws(() => validatePlanObject(unsupportedFeature), /supported set/u);
});

void test("public manifests contain no floating runtime or wildcard internal dependencies", async () => {
  const { manifests } = await loadReleaseContext(workspaceRoot);
  for (const manifest of manifests.values()) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@topik/")) {
        assert.match(version, /^workspace:0\.1\.0-alpha\.5$/u);
      } else {
        assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u);
      }
      assert.doesNotMatch(version, /(?:\*|latest|^[~^])/u);
    }
  }
});

void test("a public package version drifting from the planned cohort is rejected", async () => {
  const { plan, manifests } = await loadReleaseContext(workspaceRoot);
  const drifted = clone(manifests.get("@topik/core"));
  drifted.version = "0.1.0-alpha.4";
  assert.throws(
    () => validatePublicManifest("@topik/core", drifted, plan.releaseVersion),
    /identity does not match/u,
  );
});

void test("CLI and tag validation reject malformed or injectable inputs before execution", async () => {
  assert.throws(
    () => parseCliArguments(["publish", "--tag", 'v0.1.0-alpha.5"; npm owner add bad']),
    /missing or unexpected arguments/u,
  );
  assert.throws(
    () =>
      parseCliArguments([
        "publish",
        "--tag",
        "v0.1.0-alpha.5",
        "--tag",
        "v0.1.0-alpha.5",
        "--mode",
        "initial",
        "--artifacts",
        ".release-artifacts",
      ]),
    /duplicate/u,
  );
  let calls = 0;
  await assert.rejects(
    verifyGitTag(workspaceRoot, "v0.1.0-alpha.5;touch-pwned", "v0.1.0-alpha.5", {
      run: async () => {
        calls++;
        return "a".repeat(40);
      },
    }),
    /unsafe/u,
  );
  assert.equal(calls, 0);
  assert.equal(
    publicReleaseError(new Error(`ENOENT: ${workspaceRoot}/private-path`), workspaceRoot),
    "ENOENT: <workspace>/private-path",
  );
});

void test("tag verification binds the workflow event ref and SHA", async () => {
  const commit = "a".repeat(40);
  let calls = 0;
  const run = async () => {
    calls++;
    return commit;
  };
  await assert.rejects(
    verifyGitTag(workspaceRoot, "v0.1.0-alpha.5", "v0.1.0-alpha.5", {
      run,
      eventRef: "refs/heads/main",
      eventSha: commit,
    }),
    /event ref/u,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    verifyGitTag(workspaceRoot, "v0.1.0-alpha.5", "v0.1.0-alpha.5", {
      run,
      eventRef: "refs/tags/v0.1.0-alpha.5",
      eventSha: "b".repeat(40),
    }),
    /event SHA/u,
  );
  assert.equal(calls, 2);
  assert.equal(
    await verifyGitTag(workspaceRoot, "v0.1.0-alpha.5", "v0.1.0-alpha.5", {
      run,
      eventRef: "refs/tags/v0.1.0-alpha.5",
      eventSha: commit,
    }),
    commit,
  );
});

void test("publication and promotion workflows share immutable serialization configuration", async () => {
  const workflows = await Promise.all(
    ["publish.yaml", "promote-alpha.yaml"].map((name) =>
      readFile(resolve(workspaceRoot, ".github", "workflows", name), "utf8"),
    ),
  );
  for (const workflow of workflows) {
    assert.match(workflow, /group: topik-alpha-release/u);
    assert.match(workflow, /cancel-in-progress: false/u);
    assert.doesNotMatch(workflow, /uses:\s+[^\s#]+@(?![0-9a-f]{40}\b)/u);
  }
  assert.match(workflows[0], /workflow_dispatch:[\s\S]+tag:[\s\S]+required: true/u);
  assert.match(workflows[0], /ref: \$\{\{ env\.RELEASE_TAG \}\}/u);
  assert.match(workflows[1], /private_consumer_validation:[\s\S]+- validated/u);
});

void test("npm mutation steps use an environment-scoped granular token", async () => {
  const workflows = await Promise.all(
    ["publish.yaml", "promote-alpha.yaml"].map((name) =>
      readFile(resolve(workspaceRoot, ".github", "workflows", name), "utf8"),
    ),
  );
  for (const workflow of workflows) {
    assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/u);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.TOPIK_NPM_RELEASE_TOKEN \}\}/u);
    assert.equal(workflow.match(/TOPIK_NPM_RELEASE_TOKEN/gu)?.length, 1);
    assert.ok(
      workflow.indexOf("NODE_AUTH_TOKEN:") > workflow.indexOf("--artifacts .release-artifacts"),
    );
    assert.match(workflow, /--event-ref "\$GITHUB_REF"/u);
    assert.match(workflow, /--event-sha "\$GITHUB_SHA"/u);
  }
  assert.match(workflows[0], /id-token: write/u);
  assert.doesNotMatch(workflows[1], /id-token: write/u);
});

void test("pull-request CI runs one real Node 24 release preparation after building", async () => {
  const workflow = await readFile(
    resolve(workspaceRoot, ".github", "workflows", "ci.yaml"),
    "utf8",
  );
  const releasePackJob = /\n  release-pack:[\s\S]+$/u.exec(workflow)?.[0];
  assert.notEqual(releasePackJob, undefined);
  assert.match(releasePackJob, /node-version: "24"/u);
  assert.equal(workflow.match(/vp run release:prepare/gu)?.length, 1);
  assert.ok(
    releasePackJob.indexOf("vp run -r build") < releasePackJob.indexOf("vp run release:prepare"),
  );
  assert.match(releasePackJob, /if: always\(\)[\s\S]+rmSync\("\.release-artifacts"/u);
  assert.doesNotMatch(workflow, /uses:\s+[^\s#]+@(?![0-9a-f]{40}\b)/u);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
