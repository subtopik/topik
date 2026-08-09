import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { TOPIK_ASSET_LIMITS, TOPIK_PATH_VERSION } from "./constants";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import { validateTopikPath, validateTopikPathSet } from "./path";

const execFileAsync = promisify(execFile);

export type PortableAssetFileType =
  | "regular"
  | "symlink"
  | "hardlink"
  | "gitlink"
  | "device"
  | "fifo"
  | "socket"
  | "special"
  | "sparse"
  | "archive-link";

export interface PortableAssetFileDescriptor {
  path: string;
  type: PortableAssetFileType;
  source?: "git" | "archive" | "filesystem";
  /** Git mode (`100644`) or archive mode (`0644`). */
  mode: string;
  bytes?: Uint8Array;
  linkCount?: number;
  hasAlternateDataStream?: boolean;
  contentFilter?: string;
  workingTreeEncoding?: string;
}

export function validatePortableAssetFile(
  file: PortableAssetFileDescriptor,
): TopikAssetResult<PortableAssetFileDescriptor> {
  const diagnostics: TopikAssetDiagnostic[] = [];
  const path = validateTopikPath(file.path);
  if (!path.ok) diagnostics.push(...path.diagnostics);
  const basename = file.path.split("/").at(-1)?.toLowerCase();
  if ([".gitattributes", ".gitmodules", ".lfsconfig"].includes(basename ?? "")) {
    diagnostics.push(
      unsupported(file, "Security-sensitive Git configuration cannot be asset-owned"),
    );
  }
  if (
    file.type !== "regular" ||
    !hasPortableMode(file) ||
    (file.source !== "git" && file.linkCount !== 1) ||
    file.hasAlternateDataStream === true ||
    (file.contentFilter !== undefined && file.contentFilter !== "unspecified") ||
    file.workingTreeEncoding !== undefined
  ) {
    diagnostics.push(
      unsupported(file, "Portable assets must be unfiltered regular non-executable files"),
    );
  }
  if (file.bytes === undefined) {
    diagnostics.push(
      topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "File bytes are unavailable", {
        descriptorVersion: TOPIK_PATH_VERSION,
        location: { path: file.path },
        recovery: "restore-file",
      }),
    );
  } else if (file.bytes.byteLength > TOPIK_ASSET_LIMITS.maxAssetBytes) {
    diagnostics.push(unsupported(file, "Asset bytes exceed the portable size limit"));
  } else if (looksLikeGitLfsPointer(file.bytes)) {
    diagnostics.push(
      unsupported(file, "Git LFS pointers and near-miss signatures are not portable bytes"),
    );
  }
  return diagnostics.length === 0
    ? { ok: true, value: file, diagnostics: [] }
    : { ok: false, value: file, diagnostics };
}

export function validatePortableAssetTree(
  files: readonly PortableAssetFileDescriptor[],
): TopikAssetResult<readonly PortableAssetFileDescriptor[]> {
  const diagnostics: TopikAssetDiagnostic[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) {
      diagnostics.push(
        topikAssetDiagnostic("TOPIK_ASSET_PATH_COLLISION", "Tree repeats an exact file path", {
          descriptorVersion: TOPIK_PATH_VERSION,
          location: { path: file.path },
          reason: "casefold_collision",
        }),
      );
      continue;
    }
    seen.add(file.path);
    const validation = validatePortableAssetFile(file);
    if (!validation.ok) diagnostics.push(...validation.diagnostics);
  }
  const paths = validateTopikPathSet(files.map((file) => file.path));
  if (!paths.ok) diagnostics.push(...paths.diagnostics);
  return diagnostics.length === 0
    ? { ok: true, value: files, diagnostics: [] }
    : { ok: false, value: files, diagnostics };
}

export interface ReadPortableAssetFileOptions {
  root: string;
  path: string;
}

/** Filesystem reader using no-follow traversal and stable same-handle identity checks. */
export async function readPortableAssetFile(
  options: ReadPortableAssetFileOptions,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options);
}

/** @internal Deterministic race seam; not re-exported from the package root. */
export async function readPortableAssetFileWithTraversalHookForTest(
  options: ReadPortableAssetFileOptions,
  afterDirectoryOpened: (components: readonly string[]) => void | Promise<void>,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options, afterDirectoryOpened);
}

async function readPortableAssetFileAnchored(
  options: ReadPortableAssetFileOptions,
  afterDirectoryOpened?: (components: readonly string[]) => void | Promise<void>,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  const pathValidation = validateTopikPath(options.path);
  if (!pathValidation.ok) return { ok: false, diagnostics: pathValidation.diagnostics };

  if (
    process.platform !== "linux" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    typeof constants.O_DIRECTORY !== "number"
  ) {
    return {
      ok: false,
      diagnostics: [
        unsupportedPath(
          options.path,
          "This platform cannot prove descriptor-anchored no-follow traversal",
        ),
      ],
    };
  }

  const directoryHandles: FileHandle[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const gitAttributesBefore = await effectiveGitAttributeFingerprint(options.root, options.path);
    if (!gitAttributesBefore.ok) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, gitAttributesBefore.failure)],
      };
    }
    const expectedRoot = await lstat(options.root, { bigint: true });
    if (!expectedRoot.isDirectory() || expectedRoot.isSymbolicLink()) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, "Resource root is not a stable directory")],
      };
    }

    const rootHandle = await open(
      options.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    directoryHandles.push(rootHandle);
    const openedRoot = await rootHandle.stat({ bigint: true });
    if (
      !openedRoot.isDirectory() ||
      expectedRoot.dev !== openedRoot.dev ||
      expectedRoot.ino !== openedRoot.ino
    ) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, "Resource root identity changed before open")],
      };
    }

    const components = options.path.split("/");
    const attributes: EffectiveGitAttributes = {};
    const rootAttributeFailure = await applyGitAttributes(
      rootHandle,
      components.join("/"),
      attributes,
    );
    if (rootAttributeFailure !== undefined) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, rootAttributeFailure)],
      };
    }
    for (let index = 0; index < components.length - 1; index++) {
      const parent = directoryHandles.at(-1);
      if (parent === undefined) throw new Error("Missing anchored parent directory handle");
      const child = await open(
        procFdChild(parent.fd, components[index]),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directoryHandles.push(child);
      const stat = await child.stat({ bigint: true });
      if (!stat.isDirectory()) {
        return {
          ok: false,
          diagnostics: [unsupportedPath(options.path, "Non-directory traversal is unsupported")],
        };
      }
      const attributeFailure = await applyGitAttributes(
        child,
        components.slice(index + 1).join("/"),
        attributes,
      );
      if (attributeFailure !== undefined) {
        return {
          ok: false,
          diagnostics: [unsupportedPath(options.path, attributeFailure)],
        };
      }
      await afterDirectoryOpened?.(components.slice(0, index + 1));
    }

    if (
      (attributes.filter !== undefined && attributes.filter !== "unspecified") ||
      (attributes.workingTreeEncoding !== undefined &&
        attributes.workingTreeEncoding !== "unspecified")
    ) {
      return {
        ok: false,
        diagnostics: [
          unsupportedPath(
            options.path,
            "Effective Git content filters or working-tree encoding are not portable",
          ),
        ],
      };
    }

    const parent = directoryHandles.at(-1);
    if (parent === undefined) throw new Error("Missing anchored parent directory handle");
    fileHandle = await open(
      procFdChild(parent.fd, components.at(-1) ?? ""),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = await fileHandle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (before.mode & 0o111n) !== 0n ||
      before.size > BigInt(TOPIK_ASSET_LIMITS.maxAssetBytes) ||
      (before.size > 0n && before.blocks * 512n < before.size)
    ) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, "Unsafe filesystem file type or mode")],
      };
    }
    const bytes = await fileHandle.readFile();
    const after = await fileHandle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return {
        ok: false,
        diagnostics: [unsupportedPath(options.path, "File identity changed while hashing")],
      };
    }
    const gitAttributesAfter = await effectiveGitAttributeFingerprint(options.root, options.path);
    if (
      !gitAttributesAfter.ok ||
      gitAttributesAfter.fingerprint !== gitAttributesBefore.fingerprint
    ) {
      return {
        ok: false,
        diagnostics: [
          unsupportedPath(
            options.path,
            gitAttributesAfter.ok
              ? "Effective Git attribute evidence changed while it was evaluated"
              : gitAttributesAfter.failure,
          ),
        ],
      };
    }
    return validatePortableAssetFile({
      path: options.path,
      type: "regular",
      source: "filesystem",
      mode: "100644",
      bytes,
      linkCount: 1,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      diagnostics: [
        code === "ENOENT"
          ? topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "Asset file is missing", {
              location: { path: options.path },
              recovery: "restore-file",
            })
          : unsupportedPath(options.path, "File read failed without a portable no-follow proof"),
      ],
    };
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await Promise.all(directoryHandles.map((handle) => handle.close().catch(() => undefined)));
  }
}

type EffectiveGitAttributeProof =
  | { ok: true; fingerprint: string }
  | { ok: false; failure: string };

async function effectiveGitAttributeFingerprint(
  root: string,
  path: string,
): Promise<EffectiveGitAttributeProof> {
  if (!(await hasGitBoundary(root))) return { ok: true, fingerprint: "not-in-worktree" };
  let worktree: string;
  try {
    const result = await execFileAsync(
      "/usr/bin/git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    worktree = result.stdout.trim();
  } catch {
    return { ok: false, failure: "Git worktree boundary could not be proven" };
  }
  const rootFromWorktree = relative(resolve(worktree), resolve(root));
  if (
    rootFromWorktree === ".." ||
    rootFromWorktree.startsWith(`..${sep}`) ||
    isAbsolute(rootFromWorktree)
  ) {
    return { ok: false, failure: "Compilation root is outside its Git worktree" };
  }
  const worktreePath = [
    ...(rootFromWorktree === "" ? [] : rootFromWorktree.split(sep)),
    ...path.split("/"),
  ].join("/");
  let stdout: string;
  try {
    const result = await execFileAsync(
      "/usr/bin/git",
      ["-C", worktree, "check-attr", "-z", "filter", "working-tree-encoding", "--", worktreePath],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return { ok: false, failure: "Effective Git attributes could not be evaluated safely" };
  }
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length !== 6) {
    return { ok: false, failure: "Effective Git attribute output is malformed" };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 3) {
    if (fields[index] !== worktreePath) {
      return { ok: false, failure: "Effective Git attribute path binding changed" };
    }
    values.set(fields[index + 1], fields[index + 2]);
  }
  if (
    values.get("filter") !== "unspecified" ||
    values.get("working-tree-encoding") !== "unspecified"
  ) {
    return {
      ok: false,
      failure: "Effective Git content filters or working-tree encoding are not portable",
    };
  }
  return {
    ok: true,
    fingerprint: `${values.get("filter")}\0${values.get("working-tree-encoding")}`,
  };
}

async function hasGitBoundary(root: string): Promise<boolean> {
  let current = resolve(root);
  for (;;) {
    try {
      const stat = await lstat(`${current}/.git`);
      if (stat.isFile()) return true;
      if (stat.isDirectory()) {
        try {
          const head = await lstat(`${current}/.git/HEAD`);
          if (head.isFile()) return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

interface EffectiveGitAttributes {
  filter?: "set" | "unset" | "unspecified";
  workingTreeEncoding?: "set" | "unset" | "unspecified";
}

async function applyGitAttributes(
  directory: FileHandle,
  relativePath: string,
  state: EffectiveGitAttributes,
): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      procFdChild(directory.fd, ".gitattributes"),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      return "Git attribute evidence is not a stable regular file";
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      return "Git attribute evidence changed while it was evaluated";
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "Git attribute evidence is not strict UTF-8";
    }
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const fields = line.split(/[\t ]+/u);
      const pattern = fields.shift();
      if (pattern === undefined || pattern.startsWith('"')) {
        if (fields.some(isPortableAttributeToken)) {
          return "Quoted Git attribute patterns cannot be proven by the filesystem compiler";
        }
        continue;
      }
      if (hasUnsupportedGitAttributePattern(pattern) && fields.some(isPortableAttributeToken)) {
        return "Git attribute pattern cannot be proven by the filesystem compiler";
      }
      if (!gitAttributePatternMatches(pattern, relativePath)) continue;
      for (const token of fields) applyAttributeToken(token, state);
    }
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? undefined
      : "Git attribute evidence could not be read without following links";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function applyAttributeToken(token: string, state: EffectiveGitAttributes): void {
  const [rawName] = token.replace(/^[!-]/u, "").split("=", 1);
  const property =
    rawName === "filter"
      ? "filter"
      : rawName === "working-tree-encoding"
        ? "workingTreeEncoding"
        : undefined;
  if (property === undefined) return;
  state[property] = token.startsWith("!") ? "unspecified" : token.startsWith("-") ? "unset" : "set";
}

function isPortableAttributeToken(token: string): boolean {
  return /^(?:[!-])?(?:filter|working-tree-encoding)(?:=|$)/u.test(token);
}

function hasUnsupportedGitAttributePattern(pattern: string): boolean {
  return (
    pattern.startsWith("!") ||
    pattern.includes("\\") ||
    pattern.includes("[") ||
    pattern.includes("]") ||
    pattern.includes("**")
  );
}

function gitAttributePatternMatches(pattern: string, relativePath: string): boolean {
  if (pattern.length === 0 || pattern.startsWith("!") || pattern.endsWith("/")) return false;
  const anchored = pattern.startsWith("/");
  const normalizedPattern = anchored ? pattern.slice(1) : pattern;
  const candidate =
    anchored || normalizedPattern.includes("/")
      ? relativePath
      : (relativePath.split("/").at(-1) ?? relativePath);
  return globToRegExp(normalizedPattern).test(candidate);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "u");
}

export function looksLikeGitLfsPointer(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, 1024));
  return (
    /(?:^|\n)version\s+https?:\/\/git-lfs\.github\.com\/spec\/v1(?:\s|$)/iu.test(prefix) ||
    /(?:^|\n)oid\s+sha256:[0-9a-f]{32,64}(?:\s|$)/iu.test(prefix) ||
    /git-media|git-lfs/iu.test(prefix.slice(0, 256))
  );
}

function unsupported(file: PortableAssetFileDescriptor, message: string): TopikAssetDiagnostic {
  return unsupportedPath(file.path, message);
}

function hasPortableMode(file: PortableAssetFileDescriptor): boolean {
  if (file.source === "git" || file.source === "filesystem") return file.mode === "100644";
  if (file.source === "archive") return file.mode === "0644";
  return file.mode === "100644" || file.mode === "0644";
}

function procFdChild(parentFd: number, component: string): string {
  return `/proc/self/fd/${parentFd}/${component}`;
}

function unsupportedPath(path: string, message: string): TopikAssetDiagnostic {
  return topikAssetDiagnostic("TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", message, {
    descriptorVersion: TOPIK_PATH_VERSION,
    location: { path },
    recovery: "preserve-read-only",
  });
}
