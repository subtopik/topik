import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { publicPackages } from "./publish-alpha.mjs";

export function packPublicPackages(workspaceRoot, destination) {
  const versions = new Map(
    publicPackages.map((name) => {
      const manifest = readJson(
        join(workspaceRoot, "packages", name.slice("@topik/".length), "package.json"),
      );
      if (manifest.name !== name || manifest.private === true) {
        throw new Error(`${name} must be a public package`);
      }
      return [name, manifest.version];
    }),
  );
  const cohortVersion = versions.get(publicPackages[0]);
  if (
    typeof cohortVersion !== "string" ||
    !/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(cohortVersion) ||
    [...versions.values()].some((version) => version !== cohortVersion)
  ) {
    throw new Error("Public packages do not expose one alpha cohort version");
  }

  mkdirSync(destination, { recursive: true });
  const planPath = join(destination, "publish-plan.json");
  writeFileSync(
    planPath,
    `${JSON.stringify(
      {
        version: 1,
        plan: [
          publicPackages.map((name) => ({
            kind: "publish",
            name,
            version: versions.get(name),
            access: "public",
            tag: "alpha",
          })),
        ],
      },
      null,
      2,
    )}\n`,
  );

  const packageManager = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(
    readJson(join(workspaceRoot, "package.json")).packageManager,
  );
  if (packageManager === null) throw new Error("Expected one exact pnpm package-manager version");
  const toolDirectory = join(destination, "package-manager");
  mkdirSync(toolDirectory);
  writeFileSync(
    join(toolDirectory, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        devDependencies: { pnpm: packageManager[1] },
      },
      null,
      2,
    )}\n`,
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--package-lock=false"], {
    cwd: toolDirectory,
    stdio: "inherit",
  });

  const outputDirectory = join(destination, "packed");
  const changesetsBin = join(workspaceRoot, "node_modules", "@changesets", "cli", "bin.js");
  if (!existsSync(changesetsBin)) throw new Error("The installed Changesets CLI is unavailable");
  execFileSync(
    process.execPath,
    [changesetsBin, "pack", "--from-publish-plan", planPath, "--out-dir", outputDirectory],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PATH: `${join(toolDirectory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: "inherit",
    },
  );

  const packedPlan = readJson(join(outputDirectory, "publish-plan.json"));
  if (packedPlan.version !== 1 || !Array.isArray(packedPlan.plan)) {
    throw new Error("Changesets produced an invalid packed publish plan");
  }
  const releases = packedPlan.plan.flat();
  if (releases.length !== publicPackages.length) {
    throw new Error("Changesets did not pack the exact public package cohort");
  }
  const archives = new Map();
  for (const release of releases) {
    if (
      release.kind !== "publish" ||
      !versions.has(release.name) ||
      release.version !== versions.get(release.name) ||
      release.access !== "public" ||
      release.tag !== "alpha" ||
      typeof release.tarball?.path !== "string" ||
      typeof release.tarball.integrity !== "string" ||
      archives.has(release.name)
    ) {
      throw new Error(`Unexpected packed Changesets release: ${release.name}@${release.version}`);
    }
    const archive = resolve(outputDirectory, release.tarball.path);
    const relativeArchive = relative(outputDirectory, archive);
    if (
      isAbsolute(relativeArchive) ||
      relativeArchive === ".." ||
      relativeArchive.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      !existsSync(archive)
    ) {
      throw new Error(`Packed release ${release.name} has an invalid tarball path`);
    }
    archives.set(release.name, archive);
  }
  if (publicPackages.some((name) => !archives.has(name))) {
    throw new Error("Changesets omitted a public package archive");
  }
  return { archives, cohortVersion };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
