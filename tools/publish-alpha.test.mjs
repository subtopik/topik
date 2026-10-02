import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { publicPackages, publishAlpha } from "./publish-alpha.mjs";

const root = join(import.meta.dirname, "..");
const changeset = join(root, "node_modules", ".bin", "changeset");

describe("alpha publication retries", () => {
  test("Changesets distinguishes published, prior-alpha, and missing/E404 packages", () => {
    const temporary = mkdtempSync(join(tmpdir(), "topik-publish-plan-"));
    try {
      const fakeBin = createFakePnpm(temporary);
      const planPath = join(temporary, "plan.json");
      execFileSync(changeset, ["publish-plan", "--output", planPath], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
          PUBLISHED_PACKAGE: publicPackages[0],
          PUBLISHED_VERSION: packageVersion(publicPackages[0]),
          PRIOR_VERSION: priorVersion(publicPackages[0]),
          MISSING_PACKAGE: publicPackages.at(-1),
        },
        stdio: "pipe",
      });

      const plannedReleases = readFilePlan(planPath);
      const plannedNames = plannedReleases.map((release) => release.name);
      expect(plannedNames).not.toContain(publicPackages[0]);
      expect(plannedNames.toSorted()).toEqual(publicPackages.slice(1).toSorted());
      expect(
        plannedReleases
          .filter((release) => release.name !== publicPackages.at(-1))
          .every((release) => release.tag === "latest"),
      ).toBe(true);
      expect(plannedReleases.find((release) => release.name === publicPackages.at(-1))?.tag).toBe(
        "alpha",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("Changesets stops on an unexpected registry error", () => {
    const temporary = mkdtempSync(join(tmpdir(), "topik-publish-plan-"));
    try {
      const fakeBin = createFakePnpm(temporary);
      const planPath = join(temporary, "plan.json");
      const result = spawnSync(changeset, ["publish-plan", "--output", planPath], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
          REGISTRY_ERROR: "E429",
        },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("E429");
      expect(() => readFileSync(planPath)).toThrow();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("publishes only tarballs selected by the Changesets plan", () => {
    const temporary = mkdtempSync(join(tmpdir(), "topik-alpha-publish-"));
    const plannedNames = publicPackages.slice(1);
    const plan = createPlan(plannedNames);
    const calls = [];
    try {
      publishAlpha({
        cwd: createPublishWorkspace(temporary),
        temporaryDirectory: temporary,
        run(command, args) {
          calls.push([command, ...args]);
          if (args[2] === "publish-plan") {
            writeFileSync(option(args, "--output"), JSON.stringify(plan));
          } else if (args[2] === "pack") {
            writePackedPlan(option(args, "--out-dir"), plan);
          }
        },
      });

      const changesetCalls = calls.filter(([command]) => command === "vp");
      const publishCalls = calls.filter(([command]) => command === "npx");
      expect(changesetCalls.map((call) => call.slice(0, 4))).toEqual([
        ["vp", "exec", "changeset", "publish-plan"],
        ["vp", "exec", "changeset", "pack"],
      ]);
      expect(calls.some(([command]) => command === "pnpm")).toBe(false);
      expect(plan.plan.flat().every((release) => release.tag === "latest")).toBe(true);
      expect(publishCalls).toHaveLength(plannedNames.length);
      expect(publishCalls.every((call) => call.slice(-2).join(" ") === "--tag alpha")).toBe(true);
      expect(publishCalls.every((call) => !call.includes("latest"))).toBe(true);
      expect(publishCalls.some((call) => call.join(" ").includes("topik-remark-tags-"))).toBe(
        false,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("refuses unapplied changesets before contacting the registry or publishing", () => {
    const temporary = mkdtempSync(join(tmpdir(), "topik-unversioned-publish-"));
    try {
      const cwd = createPublishWorkspace(temporary);
      writeFileSync(join(cwd, ".changeset", "pending.md"), '---\n"@topik/content": minor\n---\n');
      const calls = [];
      expect(() =>
        publishAlpha({ cwd, temporaryDirectory: temporary, run: (...args) => calls.push(args) }),
      ).toThrow(/unapplied changesets/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("allows applied prerelease changesets and an already-published empty plan", () => {
    const temporary = mkdtempSync(join(tmpdir(), "topik-versioned-publish-"));
    try {
      const cwd = createPublishWorkspace(temporary);
      writeFileSync(
        join(cwd, ".changeset", "applied.md"),
        '---\n"@topik/content": minor\n---\nExercise release versioning.\n',
      );
      execFileSync(
        process.execPath,
        [join(root, "node_modules", "@changesets", "cli", "bin.js"), "version"],
        {
          cwd,
          stdio: "pipe",
        },
      );
      expect(() => readFileSync(join(cwd, ".changeset", "applied.md"))).toThrow();
      expect(readFileSync(join(cwd, ".changeset", "pre", "applied.md"), "utf8")).toContain(
        "Exercise release versioning.",
      );
      const calls = [];
      publishAlpha({
        cwd,
        temporaryDirectory: temporary,
        run(command, args) {
          calls.push(command);
          if (args[2] === "publish-plan") {
            writeFileSync(option(args, "--output"), JSON.stringify(createPlan([])));
          } else if (args[2] === "pack") {
            writePackedPlan(option(args, "--out-dir"), createPlan([]));
          }
        },
      });
      expect(calls).toEqual(["vp", "vp"]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function createPublishWorkspace(temporary) {
  const cwd = join(temporary, "workspace");
  mkdirSync(join(cwd, ".changeset"), { recursive: true });
  for (const name of ["package.json", "pnpm-workspace.yaml"]) {
    writeFileSync(join(cwd, name), readFileSync(join(root, name)));
  }
  writeFileSync(join(cwd, ".changeset", "pre.json"), JSON.stringify({ mode: "pre", tag: "alpha" }));
  writeFileSync(
    join(cwd, ".changeset", "config.json"),
    readFileSync(join(root, ".changeset", "config.json")),
  );
  writeFileSync(join(cwd, ".changeset", "README.md"), "Release instructions.\n");
  for (const name of [...publicPackages, "@topik/astro"]) {
    const directory = join("packages", name.slice("@topik/".length));
    mkdirSync(join(cwd, directory), { recursive: true });
    writeFileSync(
      join(cwd, directory, "package.json"),
      readFileSync(join(root, directory, "package.json")),
    );
  }
  return cwd;
}

function createFakePnpm(temporary) {
  const fakeBin = join(temporary, "bin");
  const pnpm = join(fakeBin, "pnpm");
  mkdirSync(fakeBin);
  writeFileSync(
    pnpm,
    `#!/usr/bin/env node
const target = process.argv[3];
if (process.argv[2] !== "info") process.exit(64);
if (process.env.REGISTRY_ERROR) {
  console.log(JSON.stringify({ error: { code: process.env.REGISTRY_ERROR, message: "simulated registry response" } }));
  process.exit(1);
}
if (target === process.env.MISSING_PACKAGE) {
  console.log(JSON.stringify({ error: { code: "E404", message: "simulated registry response" } }));
  process.exit(1);
}
const versions = [process.env.PRIOR_VERSION];
if (target === process.env.PUBLISHED_PACKAGE) versions.push(process.env.PUBLISHED_VERSION);
console.log(JSON.stringify({ versions, "dist-tags": { alpha: versions.at(-1), latest: process.env.PRIOR_VERSION } }));
`,
  );
  chmodSync(pnpm, 0o755);
  return fakeBin;
}

function createPlan(names) {
  return {
    version: 1,
    plan: [
      names.map((name) => ({
        kind: "publish",
        name,
        version: packageVersion(name),
        access: "public",
        tag: "latest",
      })),
    ],
  };
}

function writePackedPlan(packDirectory, plan) {
  mkdirSync(join(packDirectory, "packages"), { recursive: true });
  const packedPlan = structuredClone(plan);
  for (const release of packedPlan.plan.flat()) {
    const filename = `${release.name.slice(1).replace("/", "-")}-${release.version}.tgz`;
    release.tarball = { path: `packages/${filename}`, integrity: "sha256-test" };
    writeFileSync(join(packDirectory, release.tarball.path), "not published");
  }
  writeFileSync(join(packDirectory, "publish-plan.json"), JSON.stringify(packedPlan));
}

function readFilePlan(path) {
  return JSON.parse(readFileSync(path, "utf8")).plan.flat();
}

function packageVersion(name) {
  return JSON.parse(
    readFileSync(join(root, "packages", name.slice("@topik/".length), "package.json"), "utf8"),
  ).version;
}

function priorVersion(name) {
  return packageVersion(name).replace(/\d+$/, (number) => String(Number(number) - 1));
}

function option(args, name) {
  return args[args.indexOf(name) + 1];
}
