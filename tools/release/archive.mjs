import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  PACKAGE_DIRECTORIES,
  PUBLIC_PACKAGES,
  RELEASE_VERSION_PATTERN,
  SRI_PATTERN,
} from "./constants.mjs";
import { assertExactStringSet, validatePublicManifest } from "./plan.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const runFile = promisify(execFile);

export function archiveFilename(name, version) {
  if (!PUBLIC_PACKAGES.includes(name) || !RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error("cannot derive an archive for an unknown package or unsafe version");
  }
  return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

export async function prepareArchives(workspaceRoot, artifactInput, context, hooks = {}) {
  const artifactDirectory = await resolveArtifactDirectory(workspaceRoot, artifactInput, {
    mustExist: false,
  });
  await mkdir(artifactDirectory, { mode: 0o700 });
  const run = hooks.run ?? runCommand;

  for (const name of context.plan.packages) {
    const packageDirectory = join(workspaceRoot, PACKAGE_DIRECTORIES[name]);
    const filename = archiveFilename(name, context.plan.releaseVersion);
    const destination = join(artifactDirectory, filename);
    if (await pathExists(destination))
      throw new Error("release archive destination already exists");
    await run("pnpm", ["pack", "--pack-destination", artifactDirectory], {
      cwd: packageDirectory,
      label: `packing ${name}`,
    });
    if (!(await isRegularFile(destination)))
      throw new Error(`${name} did not produce its expected archive`);
  }

  const archives = await loadAndVerifyArchives(workspaceRoot, artifactInput, context);
  if (hooks.verifyConsumer !== false) {
    await verifyTemporaryConsumer(archives, context.plan.releaseVersion, hooks);
  }
  return archives;
}

export async function loadAndVerifyArchives(workspaceRoot, artifactInput, context) {
  const artifactDirectory = await resolveArtifactDirectory(workspaceRoot, artifactInput, {
    mustExist: true,
  });
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const expected = context.plan.packages.map((name) =>
    archiveFilename(name, context.plan.releaseVersion),
  );
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("release artifact directory contains a non-regular entry");
  }
  assertExactStringSet(
    entries.map((entry) => entry.name),
    expected,
    "release archive filenames",
  );

  const archives = new Map();
  for (const name of context.plan.packages) {
    const filename = archiveFilename(name, context.plan.releaseVersion);
    const path = join(artifactDirectory, filename);
    const archive = await verifyArchive(workspaceRoot, path, name, context.plan.releaseVersion);
    archives.set(name, { ...archive, filename, path });
  }
  return archives;
}

export async function verifyArchive(workspaceRoot, archivePath, name, version) {
  const archiveBytes = await readFile(archivePath).catch(() => {
    throw new Error(`${name} release archive could not be read`);
  });
  if (archiveBytes.length > 32 * 1024 * 1024) {
    throw new Error(`${name} release archive is unexpectedly large`);
  }
  let unpacked;
  try {
    unpacked = gunzipSync(archiveBytes, { maxOutputLength: 128 * 1024 * 1024 });
  } catch {
    throw new Error(`${name} release archive is not valid gzip data`);
  }
  const entries = parseTar(unpacked, name);
  const expectedEntries = await intendedPacklist(workspaceRoot, name);
  assertExactStringSet([...entries.keys()], expectedEntries, `${name} archive entries`);

  const manifestBytes = entries.get("package/package.json")?.bytes;
  if (manifestBytes === undefined) throw new Error(`${name} archive has no package manifest`);
  const manifest = parseStrictJson(manifestBytes.toString("utf8"), `${name} packed manifest`);
  validatePublicManifest(name, manifest, version, { packed: true });
  validatePackedInternalDependencies(name, manifest, version);
  validateExportTargets(name, manifest, entries);

  const license = entries.get("package/LICENSE")?.bytes;
  const canonicalLicense = await readFile(join(workspaceRoot, "LICENSE"));
  if (license === undefined || !license.equals(canonicalLicense)) {
    throw new Error(`${name} archive license does not match the repository license`);
  }
  if (![...entries.keys()].some((entry) => entry.endsWith(".mjs"))) {
    throw new Error(`${name} archive has no generated runtime module`);
  }
  if (![...entries.keys()].some((entry) => entry.endsWith(".d.mts"))) {
    throw new Error(`${name} archive has no generated declarations`);
  }

  const integrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  if (!SRI_PATTERN.test(integrity))
    throw new Error(`${name} archive integrity could not be derived`);
  return {
    name,
    version,
    integrity,
    manifest,
    entries: [...entries.keys()].sort((left, right) => left.localeCompare(right)),
  };
}

export async function verifyTemporaryConsumer(archives, version, hooks = {}) {
  const consumerDirectory = await mkdtemp(join(tmpdir(), "topik-release-consumer-"));
  const run = hooks.run ?? runCommand;
  try {
    const dependencies = {
      react: "19.2.8",
      "react-dom": "19.2.8",
    };
    const overrides = {};
    for (const name of PUBLIC_PACKAGES) {
      const archive = archives.get(name);
      if (archive === undefined) throw new Error("temporary consumer is missing a planned archive");
      dependencies[name] = `file:${archive.path}`;
      overrides[name] = `file:${archive.path}`;
    }
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "topik-release-consumer",
          private: true,
          version: "0.0.0",
          packageManager: "pnpm@10.30.0",
          dependencies,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(consumerDirectory, "pnpm-workspace.yaml"),
      `${JSON.stringify({ packages: [], overrides }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await run("pnpm", ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"], {
      cwd: consumerDirectory,
      label: "installing the packed release in a temporary consumer",
    });
    for (const name of PUBLIC_PACKAGES) {
      const manifestPath = join(
        consumerDirectory,
        "node_modules",
        ...name.split("/"),
        "package.json",
      );
      const installed = parseStrictJson(
        await readFile(manifestPath, "utf8").catch(() => {
          throw new Error("temporary consumer did not install the complete Topik cohort");
        }),
        "installed package manifest",
      );
      if (installed.name !== name || installed.version !== version) {
        throw new Error("temporary consumer resolved a mixed Topik cohort");
      }
    }
  } finally {
    await rm(consumerDirectory, { recursive: true, force: true });
  }
}

export async function resolveArtifactDirectory(workspaceRoot, input, { mustExist }) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    isAbsolute(input) ||
    input.includes("\\") ||
    input.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !/^[A-Za-z0-9._/-]+$/u.test(input)
  ) {
    throw new Error("release artifact path must be a safe workspace-relative path");
  }
  const root = await realpath(workspaceRoot);
  const target = resolve(root, input);
  const rootRelative = relative(root, target);
  if (rootRelative.startsWith(`..${sep}`) || rootRelative === ".." || isAbsolute(rootRelative)) {
    throw new Error("release artifact path escapes the workspace");
  }
  const parent = await realpath(dirname(target)).catch(() => null);
  if (parent === null || (parent !== root && !parent.startsWith(`${root}${sep}`))) {
    throw new Error("release artifact parent is unavailable or unsafe");
  }
  const status = await lstat(target).catch(() => null);
  if (mustExist) {
    if (status === null || !status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("release artifact directory is missing or unsafe");
    }
  } else if (status !== null) {
    throw new Error("release artifact directory already exists");
  }
  return target;
}

export function parseTar(bytes, name = "package") {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length % 512 !== 0) {
    throw new Error(`${name} release archive has an invalid tar payload`);
  }
  const entries = new Map();
  let offset = 0;
  let ended = false;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0)) {
        throw new Error(`${name} release archive has data after its terminator`);
      }
      ended = true;
      break;
    }
    validateTarChecksum(header, name);
    const filename = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const path = prefix === "" ? filename : `${prefix}/${filename}`;
    if (
      path === "" ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !path.startsWith("package/")
    ) {
      throw new Error(`${name} release archive contains an unsafe path`);
    }
    const type = String.fromCharCode(header[156]);
    if (type !== "\0" && type !== "0") {
      throw new Error(`${name} release archive contains a link or special file`);
    }
    const size = readTarOctal(header, 124, 12, name);
    const mode = readTarOctal(header, 100, 8, name);
    if (mode > 0o7777) throw new Error(`${name} release archive has an invalid file mode`);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || nextOffset > bytes.length) {
      throw new Error(`${name} release archive contains an invalid file size`);
    }
    if (entries.has(path)) throw new Error(`${name} release archive contains duplicate entries`);
    entries.set(path, { bytes: bytes.subarray(dataOffset, dataOffset + size), mode });
    offset = nextOffset;
  }
  if (!ended || entries.size === 0) throw new Error(`${name} release archive is not terminated`);
  return entries;
}

async function intendedPacklist(workspaceRoot, name) {
  const packageRoot = join(workspaceRoot, PACKAGE_DIRECTORIES[name]);
  const result = ["package/LICENSE", "package/package.json"];
  await walkRegularFiles(join(packageRoot, "dist"), "package/dist", result, name);
  return result.sort((left, right) => left.localeCompare(right));
}

async function walkRegularFiles(directory, archiveDirectory, result, name) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw new Error(`${name} build output is missing`);
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const diskPath = join(directory, entry.name);
    const archivePath = `${archiveDirectory}/${entry.name}`;
    const status = await lstat(diskPath);
    if (status.isSymbolicLink() || (!status.isFile() && !status.isDirectory())) {
      throw new Error(`${name} build output contains a link or special file`);
    }
    if (status.isDirectory()) await walkRegularFiles(diskPath, archivePath, result, name);
    else result.push(archivePath);
  }
}

function validatePackedInternalDependencies(name, manifest, version) {
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const dependencies = manifest[section];
    if (dependencies === undefined) continue;
    for (const [dependency, dependencyVersion] of Object.entries(dependencies)) {
      if (dependency.startsWith("@topik/") && dependencyVersion !== version) {
        throw new Error(`${name} packed an inexact internal Topik dependency`);
      }
    }
  }
}

function validateExportTargets(name, manifest, entries) {
  const targets = [];
  collectExportTargets(manifest.exports, targets);
  if (manifest.bin !== undefined) collectExportTargets(manifest.bin, targets);
  for (const target of targets) {
    if (typeof target !== "string" || !target.startsWith("./") || target.includes("..")) {
      throw new Error(`${name} has an unsafe packed export target`);
    }
    const archiveTarget = `package/${target.slice(2)}`;
    if (archiveTarget.includes("*")) {
      const pattern = new RegExp(`^${archiveTarget.split("*").map(escapeRegExp).join(".+")}$`, "u");
      if (![...entries.keys()].some((entry) => pattern.test(entry))) {
        throw new Error(`${name} packed export pattern has no generated target`);
      }
    } else if (!entries.has(archiveTarget)) {
      throw new Error(`${name} packed export target is missing`);
    }
  }
  if (manifest.bin !== undefined) {
    const binTargets = [];
    collectExportTargets(manifest.bin, binTargets);
    for (const target of binTargets) {
      const entry = entries.get(`package/${target.slice(2)}`);
      if (target.includes("*") || entry === undefined || (entry.mode & 0o111) === 0) {
        throw new Error(`${name} packed binary target is missing or not executable`);
      }
    }
  }
}

function collectExportTargets(value, targets) {
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("packed exports must contain only objects and string targets");
  }
  for (const target of Object.values(value)) collectExportTargets(target, targets);
}

function validateTarChecksum(header, name) {
  const expected = readTarOctal(header, 148, 8, name);
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error(`${name} release archive has an invalid tar checksum`);
}

function readTarText(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function readTarOctal(header, offset, length, name) {
  const value = readTarText(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error(`${name} release archive has invalid tar metadata`);
  return Number.parseInt(value, 8);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function runCommand(command, arguments_, options) {
  try {
    await runFile(command, arguments_, {
      cwd: options.cwd,
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${options.label} failed`);
  }
}

async function pathExists(path) {
  return (await lstat(path).catch(() => null)) !== null;
}

async function isRegularFile(path) {
  const status = await lstat(path).catch(() => null);
  return status?.isFile() === true && !status.isSymbolicLink();
}
