import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const publicPackages = [
  "@topik/content-schema",
  "@topik/schema",
  "@topik/core",
  "@topik/content-react",
  "@topik/cli",
  "@topik/codemod",
];

const root = join(import.meta.dirname, "..");

export function publishAlpha({
  cwd = root,
  temporaryDirectory = process.env.RUNNER_TEMP ?? tmpdir(),
  run = runCommand,
} = {}) {
  const versions = validateWorkspace(cwd);
  const releaseDirectory = mkdtempSync(join(temporaryDirectory, "topik-alpha-"));
  const planPath = join(releaseDirectory, "publish-plan.json");
  const packDirectory = join(releaseDirectory, "packed");

  run("pnpm", ["changeset", "publish-plan", "--output", planPath], { cwd });
  const releases = validatePlan(readJson(planPath), versions);

  run("pnpm", ["changeset", "pack", "--from-publish-plan", planPath, "--out-dir", packDirectory], {
    cwd,
  });
  const packedReleases = validatePlan(
    readJson(join(packDirectory, "publish-plan.json")),
    versions,
    packDirectory,
  );

  if (releaseSignature(releases) !== releaseSignature(packedReleases)) {
    throw new Error("The packed Changesets plan does not match the selected releases");
  }

  for (const { name, version, tarballPath } of packedReleases) {
    console.log(`Publishing ${name}@${version} with tag alpha`);
    run(
      "npx",
      [
        "-y",
        "npm@11.13.0",
        "publish",
        tarballPath,
        "--provenance",
        "--access",
        "public",
        "--tag",
        "alpha",
      ],
      { cwd },
    );
  }
}

function validateWorkspace(cwd) {
  const preState = readJson(join(cwd, ".changeset", "pre.json"));
  if (preState.mode !== "pre" || preState.tag !== "alpha") {
    throw new Error("Changesets must be in alpha prerelease mode");
  }

  const config = readJson(join(cwd, ".changeset", "config.json"));
  if (
    config.fixed?.length !== 1 ||
    JSON.stringify(config.fixed[0].toSorted()) !== JSON.stringify(publicPackages.toSorted())
  ) {
    throw new Error("Changesets must contain the exact six-package fixed group");
  }

  const versions = new Map();
  let cohortVersion;
  for (const name of publicPackages) {
    const packageJson = readJson(
      join(cwd, "packages", name.slice("@topik/".length), "package.json"),
    );
    if (packageJson.name !== name || packageJson.private === true) {
      throw new Error(`${name} must be a public package`);
    }
    if (!/^\d+\.\d+\.\d+-alpha\.\d+$/.test(packageJson.version)) {
      throw new Error(`${name} must have an alpha prerelease version`);
    }
    cohortVersion ??= packageJson.version;
    if (packageJson.version !== cohortVersion) {
      throw new Error("The six public packages must use one alpha version");
    }
    versions.set(name, packageJson.version);
  }

  const astro = readJson(join(cwd, "packages", "astro", "package.json"));
  if (astro.name !== "@topik/astro" || astro.private !== true) {
    throw new Error("@topik/astro must remain private and outside the publish plan");
  }

  return versions;
}

function validatePlan(plan, versions, packDirectory) {
  if (plan.version !== 1 || !Array.isArray(plan.plan)) {
    throw new Error("Invalid Changesets publish plan");
  }

  const names = new Set();
  const releases = [];
  for (const chunk of plan.plan) {
    if (!Array.isArray(chunk)) throw new Error("Invalid Changesets publish-plan chunk");
    for (const release of chunk) {
      if (
        release.kind !== "publish" ||
        !versions.has(release.name) ||
        release.version !== versions.get(release.name) ||
        release.access !== "public" ||
        names.has(release.name)
      ) {
        throw new Error(`Unexpected Changesets release: ${release.name}@${release.version}`);
      }
      names.add(release.name);

      let tarballPath;
      if (packDirectory !== undefined) {
        if (typeof release.tarball?.path !== "string") {
          throw new Error(`Packed release ${release.name} has no tarball path`);
        }
        tarballPath = resolve(packDirectory, release.tarball.path);
        const pathFromPackDirectory = relative(packDirectory, tarballPath);
        if (
          isAbsolute(pathFromPackDirectory) ||
          pathFromPackDirectory === ".." ||
          pathFromPackDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
          !existsSync(tarballPath)
        ) {
          throw new Error(`Packed release ${release.name} has an invalid tarball path`);
        }
      }
      releases.push({ name: release.name, version: release.version, tarballPath });
    }
  }
  return releases;
}

function releaseSignature(releases) {
  return JSON.stringify(releases.map(({ name, version }) => [name, version]));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runCommand(command, args, options) {
  execFileSync(command, args, { ...options, stdio: "inherit" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishAlpha();
}
