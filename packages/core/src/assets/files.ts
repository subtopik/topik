import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TOPIK_ASSET_LIMITS, TOPIK_PATH_VERSION } from "./constants";
import {
  topikAssetDiagnostic,
  type TopikAssetDiagnostic,
  type TopikAssetResult,
} from "./diagnostics";
import { validateTopikPath, validateTopikPathSet } from "./path";

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

/**
 * @internal Stable category of a refused portable read. Compiler errors expose it as a
 * sanitized reason; diagnostic wording stays a non-contractual debugging aid.
 */
export type PortableReadFailureReason =
  | "symbolic-link"
  | "hard-linked"
  | "executable"
  | "special-file"
  | "too-large"
  | "git-lfs-pointer"
  | "git-filtered"
  | "git-submodule"
  | "git-evidence-unavailable"
  | "git-repository-untrusted"
  | "platform-unsupported"
  | "changed-during-read";

interface PortableReadFailure {
  message: string;
  reason?: PortableReadFailureReason;
}

const failureReasons = new WeakMap<TopikAssetDiagnostic, PortableReadFailureReason>();

/** @internal First stable failure category attached by the portable reader, if any. */
export function portableReadFailureReason(
  diagnostics: readonly TopikAssetDiagnostic[],
): PortableReadFailureReason | undefined {
  for (const diagnostic of diagnostics) {
    const reason = failureReasons.get(diagnostic);
    if (reason !== undefined) return reason;
  }
  return undefined;
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
    diagnostics.push(unsupported(file, "Asset bytes exceed the portable size limit", "too-large"));
  } else if (looksLikeGitLfsPointer(file.bytes)) {
    diagnostics.push(
      unsupported(
        file,
        "Git LFS pointers and near-miss signatures are not portable bytes",
        "git-lfs-pointer",
      ),
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
  /** Optional tighter read limit; cannot exceed the portable asset maximum. */
  maxBytes?: number;
}

/**
 * @internal Repository evidence shared by the reads of one compilation. Evidence is computed
 * once per root and revalidated around every read with cheap `lstat` stamps; Git is only
 * consulted again when those stamps change.
 */
export interface PortableReadSession {
  readonly repositories: Map<string, RepositoryEvidence>;
}

/** @internal */
export function createPortableReadSession(): PortableReadSession {
  return { repositories: new Map() };
}

export type PortableNavigationPathKind = "directory" | "missing" | "other";

/** @internal Classify directory navigation through anchored no-follow handles. */
export async function classifyPortableNavigationPath(
  options: ReadPortableAssetFileOptions,
): Promise<PortableNavigationPathKind> {
  const pathValidation = validateTopikPath(options.path);
  if (!pathValidation.ok) return "other";
  if (!hasAnchoredTraversal()) {
    // Without anchored traversal only absence is reported; it is what link resolution needs
    // to treat a nonexistent file as a page route rather than as an unreadable download.
    return (await isPortablePathMissing(options)) ? "missing" : "other";
  }

  const handles: FileHandle[] = [];
  try {
    const expectedRoot = await lstat(options.root, { bigint: true });
    if (!expectedRoot.isDirectory() || expectedRoot.isSymbolicLink()) return "other";
    const root = await open(
      options.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(root);
    const openedRoot = await root.stat({ bigint: true });
    if (
      !openedRoot.isDirectory() ||
      expectedRoot.dev !== openedRoot.dev ||
      expectedRoot.ino !== openedRoot.ino
    ) {
      return "other";
    }

    for (const component of pathValidation.value.path.split("/")) {
      const parent = handles.at(-1);
      if (parent === undefined) return "other";
      const child = await open(
        procFdChild(parent.fd, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(child);
      if (!(await child.stat({ bigint: true })).isDirectory()) return "other";
    }
    return "directory";
  } catch (error) {
    return isMissingFilesystemError(error) ? "missing" : "other";
  } finally {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
  }
}

function isMissingFilesystemError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function hasAnchoredTraversal(): boolean {
  return (
    process.platform === "linux" &&
    typeof constants.O_NOFOLLOW === "number" &&
    typeof constants.O_DIRECTORY === "number"
  );
}

async function isPortablePathMissing(options: ReadPortableAssetFileOptions): Promise<boolean> {
  try {
    await lstat(resolve(options.root, ...options.path.split("/")));
    return false;
  } catch (error) {
    return isMissingFilesystemError(error);
  }
}

/** Filesystem reader using no-follow traversal and stable same-handle identity checks. */
export async function readPortableAssetFile(
  options: ReadPortableAssetFileOptions,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options, createPortableReadSession());
}

/** @internal Read with repository evidence shared across one compilation. */
export async function readPortableAssetFileInSession(
  session: PortableReadSession,
  options: ReadPortableAssetFileOptions,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options, session);
}

/** @internal Deterministic race seam; not re-exported from the package root. */
export async function readPortableAssetFileWithTraversalHookForTest(
  options: ReadPortableAssetFileOptions,
  afterDirectoryOpened: (components: readonly string[]) => void | Promise<void>,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options, createPortableReadSession(), afterDirectoryOpened);
}

/** @internal Deterministic same-handle race seam; not re-exported from the package root. */
export async function readPortableAssetFileWithReadHookForTest(
  options: ReadPortableAssetFileOptions,
  afterFileRead: () => void | Promise<void>,
  session: PortableReadSession = createPortableReadSession(),
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  return readPortableAssetFileAnchored(options, session, undefined, afterFileRead);
}

async function readPortableAssetFileAnchored(
  options: ReadPortableAssetFileOptions,
  session: PortableReadSession,
  afterDirectoryOpened?: (components: readonly string[]) => void | Promise<void>,
  afterFileRead?: () => void | Promise<void>,
): Promise<TopikAssetResult<PortableAssetFileDescriptor>> {
  const pathValidation = validateTopikPath(options.path);
  if (!pathValidation.ok) return { ok: false, diagnostics: pathValidation.diagnostics };
  const maxBytes = options.maxBytes ?? TOPIK_ASSET_LIMITS.maxAssetBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > TOPIK_ASSET_LIMITS.maxAssetBytes
  ) {
    return { ok: false, diagnostics: [unsupportedPath(options.path, "Invalid file read limit")] };
  }

  if (!hasAnchoredTraversal()) {
    return {
      ok: false,
      diagnostics: [
        (await isPortablePathMissing(options))
          ? missingFile(options.path)
          : unsupportedPath(
              options.path,
              "This platform cannot prove descriptor-anchored no-follow traversal",
              "platform-unsupported",
            ),
      ],
    };
  }

  const fail = (failure: PortableReadFailure): TopikAssetResult<PortableAssetFileDescriptor> => ({
    ok: false,
    diagnostics: [unsupportedPath(options.path, failure.message, failure.reason)],
  });
  const directoryHandles: FileHandle[] = [];
  const gitBoundaryFingerprints: string[] = [];
  let fileHandle: FileHandle | undefined;
  try {
    const repository = await sessionRepositoryEvidence(session, options.root);
    if (!repository.ok) return fail(repository.failure);
    const worktreePath =
      repository.kind === "worktree"
        ? [
            ...(repository.rootFromWorktree === "" ? [] : [repository.rootFromWorktree]),
            options.path,
          ].join("/")
        : undefined;
    if (
      repository.kind === "worktree" &&
      worktreePath !== undefined &&
      repository.gitlinks.some((gitlink) => isPathAtOrBelow(worktreePath, gitlink))
    ) {
      return fail({
        message: "Asset path traverses a Gitlink index entry",
        reason: "git-submodule",
      });
    }

    const expectedRoot = await lstat(options.root, { bigint: true });
    if (!expectedRoot.isDirectory() || expectedRoot.isSymbolicLink()) {
      return fail({
        message: "Resource root is not a stable directory",
        reason: expectedRoot.isSymbolicLink() ? "symbolic-link" : "special-file",
      });
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
      return fail({
        message: "Resource root identity changed before open",
        reason: "changed-during-read",
      });
    }
    const rootGitBoundary = await anchoredGitBoundaryFingerprint(rootHandle);
    if (!rootGitBoundary.ok) return fail(rootGitBoundary.failure);
    gitBoundaryFingerprints.push(rootGitBoundary.fingerprint);

    const components = options.path.split("/");
    // Inside a Git worktree, `git check-attr` evaluates the exact path after the read.
    // Outside one, the filesystem parser is the only attribute evidence.
    const attributes: EffectiveGitAttributes | undefined =
      repository.kind === "none" ? { macros: new Set() } : undefined;
    if (attributes !== undefined) {
      const rootAttributeFailure = await applyGitAttributes(
        rootHandle,
        components.join("/"),
        attributes,
      );
      if (rootAttributeFailure !== undefined) return fail(rootAttributeFailure);
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
        return fail({ message: "Non-directory traversal is unsupported", reason: "special-file" });
      }
      const gitBoundary = await anchoredGitBoundaryFingerprint(child);
      if (!gitBoundary.ok) return fail(gitBoundary.failure);
      if (gitBoundary.present) {
        return fail({
          message: "Nested Git worktree or submodule traversal is unsupported",
          reason: "git-submodule",
        });
      }
      gitBoundaryFingerprints.push(gitBoundary.fingerprint);
      if (attributes !== undefined) {
        const attributeFailure = await applyGitAttributes(
          child,
          components.slice(index + 1).join("/"),
          attributes,
        );
        if (attributeFailure !== undefined) return fail(attributeFailure);
      }
      await afterDirectoryOpened?.(components.slice(0, index + 1));
    }

    if (
      attributes !== undefined &&
      ((attributes.filter !== undefined && attributes.filter !== "unspecified") ||
        (attributes.workingTreeEncoding !== undefined &&
          attributes.workingTreeEncoding !== "unspecified"))
    ) {
      return fail({
        message: "Effective Git content filters or working-tree encoding are not portable",
        reason: "git-filtered",
      });
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
    const unsafeFile = unsafeFilesystemFileReason(before, maxBytes);
    if (unsafeFile !== undefined) return fail(unsafeFile);
    // Bound allocation/read even if the file grows after stat. The identity check below
    // rejects any mutation; one extra byte detects growth without an unbounded readFile.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fileHandle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    await afterFileRead?.();
    const after = await fileHandle.stat({ bigint: true });
    if (!hasStableFileIdentity(before, after)) {
      return fail({
        message: "File identity changed while hashing",
        reason: "changed-during-read",
      });
    }
    for (let index = 0; index < directoryHandles.length; index++) {
      const gitBoundary = await anchoredGitBoundaryFingerprint(directoryHandles[index]);
      if (!gitBoundary.ok) return fail(gitBoundary.failure);
      if (
        gitBoundary.fingerprint !== gitBoundaryFingerprints[index] ||
        (index > 0 && gitBoundary.present)
      ) {
        return fail({
          message: "Git worktree boundary evidence changed while the file was read",
          reason: "changed-during-read",
        });
      }
    }
    if (repository.kind === "worktree" && worktreePath !== undefined) {
      // Attributes are proven after the bytes were read from an identity-stable file, so
      // the result describes those bytes; a filter added later is a later change.
      const attributeFailure = await effectiveGitAttributeFailure(
        repository.worktree,
        worktreePath,
      );
      if (attributeFailure !== undefined) return fail(attributeFailure);
    }
    const repositoryFailure = await verifyRepositoryEvidence(session, options.root, repository);
    if (repositoryFailure !== undefined) return fail(repositoryFailure);
    return validatePortableAssetFile({
      path: options.path,
      type: "regular",
      source: "filesystem",
      mode: "100644",
      bytes,
      linkCount: Number(after.nlink),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      diagnostics: [
        code === "ENOENT"
          ? missingFile(options.path)
          : code === "ELOOP"
            ? unsupportedPath(
                options.path,
                "Symbolic links cannot be read; replace the link with the file or directory it names",
                "symbolic-link",
              )
            : unsupportedPath(options.path, "File read failed without a portable no-follow proof"),
      ],
    };
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await Promise.all(directoryHandles.map((handle) => handle.close().catch(() => undefined)));
  }
}

function missingFile(path: string): TopikAssetDiagnostic {
  return topikAssetDiagnostic("TOPIK_ASSET_FILE_MISSING", "Asset file is missing", {
    location: { path },
    recovery: "restore-file",
  });
}

type RepositoryEvidence =
  | {
      ok: true;
      kind: "none";
      canonicalRoot: string;
      stamp: string;
    }
  | {
      ok: true;
      kind: "worktree";
      canonicalRoot: string;
      worktree: string;
      /** Portable `/` spelling of the canonical root relative to the worktree. */
      rootFromWorktree: string;
      indexPath: string;
      gitlinks: readonly string[];
      stamp: string;
    }
  | { ok: false; failure: PortableReadFailure };

type ProvenRepositoryEvidence = Extract<RepositoryEvidence, { ok: true }>;

async function sessionRepositoryEvidence(
  session: PortableReadSession,
  root: string,
): Promise<RepositoryEvidence> {
  const key = resolve(root);
  const cached = session.repositories.get(key);
  if (cached !== undefined && (!cached.ok || (await repositoryStamp(cached)) === cached.stamp)) {
    return cached;
  }
  const evidence = await computeRepositoryEvidence(key);
  session.repositories.set(key, evidence);
  return evidence;
}

/** Fail when the repository evidence a read relied on no longer holds after the read. */
async function verifyRepositoryEvidence(
  session: PortableReadSession,
  root: string,
  before: ProvenRepositoryEvidence,
): Promise<PortableReadFailure | undefined> {
  if ((await repositoryStamp(before)) === before.stamp) return undefined;
  // A stamp also changes for harmless updates such as an index stat refresh, so compare the
  // evidence itself before failing.
  const key = resolve(root);
  const after = await computeRepositoryEvidence(key);
  session.repositories.set(key, after);
  if (!after.ok) return after.failure;
  const same =
    after.kind === before.kind &&
    (after.kind === "none" ||
      (before.kind === "worktree" &&
        after.worktree === before.worktree &&
        after.rootFromWorktree === before.rootFromWorktree &&
        after.gitlinks.join("\0") === before.gitlinks.join("\0")));
  return same
    ? undefined
    : {
        message: "Git repository evidence changed while the file was read",
        reason: "changed-during-read",
      };
}

async function computeRepositoryEvidence(root: string): Promise<RepositoryEvidence> {
  // Git discovers repositories from the canonical directory, so evaluate the same one.
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    canonicalRoot = root;
  }
  const boundary = await gitBoundaryEvidence(canonicalRoot);
  if (!boundary.present) return { ok: true, kind: "none", canonicalRoot, stamp: boundary.stamp };
  const revParse = await runGit(
    [
      "-C",
      canonicalRoot,
      "rev-parse",
      "--show-toplevel",
      "--git-path",
      "index",
      "--show-superproject-working-tree",
    ],
    64 * 1024,
  );
  if (!revParse.ok) {
    // Git itself found no repository (for example, an ancestor `.git` that is not a valid
    // repository), so no Git attributes or index entries apply to this tree.
    return revParse.notRepository
      ? { ok: true, kind: "none", canonicalRoot, stamp: boundary.stamp }
      : { ok: false, failure: revParse.failure };
  }
  const lines = revParse.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 3) {
    return {
      ok: false,
      failure: {
        message: "Compilation root traverses a checked-out Git submodule",
        reason: "git-submodule",
      },
    };
  }
  if (lines.length !== 2 || !isAbsolute(lines[0]) || lines[1].length === 0) {
    return {
      ok: false,
      failure: {
        message: "Git repository evidence is malformed",
        reason: "git-evidence-unavailable",
      },
    };
  }
  const worktree = lines[0];
  const indexPath = resolve(canonicalRoot, lines[1]);
  const rootFromWorktree = relative(worktree, canonicalRoot);
  if (
    rootFromWorktree === ".." ||
    rootFromWorktree.startsWith(`..${sep}`) ||
    isAbsolute(rootFromWorktree)
  ) {
    return {
      ok: false,
      failure: {
        message: "Compilation root is outside its Git worktree",
        reason: "git-evidence-unavailable",
      },
    };
  }
  const stamp = await worktreeStamp(boundary.stamp, worktree, indexPath);
  const index = await runGit(["-C", worktree, "ls-files", "--stage", "-z"], 64 * 1024 * 1024);
  if (!index.ok) return { ok: false, failure: index.failure };
  const gitlinks: string[] = [];
  for (const entry of index.stdout.split("\0")) {
    if (entry.length === 0) continue;
    const separator = entry.indexOf("\t");
    if (separator === -1) {
      return {
        ok: false,
        failure: { message: "Git index evidence is malformed", reason: "git-evidence-unavailable" },
      };
    }
    const [mode] = entry.slice(0, separator).split(" ");
    if (mode === "160000") gitlinks.push(entry.slice(separator + 1));
  }
  return {
    ok: true,
    kind: "worktree",
    canonicalRoot,
    worktree,
    rootFromWorktree: rootFromWorktree === "" ? "" : rootFromWorktree.split(sep).join("/"),
    indexPath,
    gitlinks,
    stamp,
  };
}

async function repositoryStamp(evidence: ProvenRepositoryEvidence): Promise<string> {
  const boundary = await gitBoundaryEvidence(evidence.canonicalRoot);
  return evidence.kind === "none"
    ? boundary.stamp
    : worktreeStamp(boundary.stamp, evidence.worktree, evidence.indexPath);
}

async function worktreeStamp(boundary: string, worktree: string, indexPath: string) {
  return [boundary, await entryStamp(indexPath), await entryStamp(join(worktree, ".git"))].join(
    "\0",
  );
}

async function entryStamp(path: string): Promise<string> {
  try {
    const stats = await lstat(path, { bigint: true });
    return stats.isDirectory() ? identityStamp(stats) : statStamp(stats);
  } catch (error) {
    return `error:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

function identityStamp(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.mode].join(":");
}

function statStamp(stats: BigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.ctimeNs,
    stats.mtimeNs,
  ].join(":");
}

/**
 * Walk every ancestor for `.git` entries. Any entry Git could treat as a repository marks the
 * tree as possibly inside a worktree; the stamp records all of them so a later change is seen.
 */
async function gitBoundaryEvidence(
  canonicalRoot: string,
): Promise<{ present: boolean; stamp: string }> {
  let present = false;
  const parts: string[] = [];
  let current = canonicalRoot;
  for (;;) {
    const marker = join(current, ".git");
    try {
      const entry = await lstat(marker, { bigint: true });
      // Directory timestamps change with every lock file Git creates; identity suffices.
      parts.push(`${current}\0${entry.isDirectory() ? identityStamp(entry) : statStamp(entry)}`);
      if (entry.isDirectory()) {
        try {
          const head = await lstat(join(marker, "HEAD"), { bigint: true });
          parts.push(identityStamp(head));
          present ||= !head.isDirectory();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") present = true;
        }
      } else {
        // A gitfile, or anything Git might resolve, needs Git's own answer.
        present = true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        present = true;
        parts.push(`${current}\0error:${code ?? "unknown"}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) return { present, stamp: parts.join("\n") };
    current = parent;
  }
}

function isPathAtOrBelow(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Bound each Git process so an unresponsive repository cannot stall compilation. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * Absolute locations searched for Git. `PATH` is deliberately not consulted: it can contain
 * relative or project-local entries, and evidence about a source tree must not come from an
 * executable that tree (or whoever controls `PATH`) supplies.
 */
const TRUSTED_GIT_LOCATIONS = [
  "/usr/bin/git",
  "/bin/git",
  "/usr/local/bin/git",
  "/run/current-system/sw/bin/git",
  "/nix/var/nix/profiles/default/bin/git",
] as const;

let trustedGit: string | undefined;

/** @internal First executable from `candidates` that is owned by root or the current user. */
export async function findTrustedGitExecutable(
  candidates: readonly string[] = TRUSTED_GIT_LOCATIONS,
): Promise<string | undefined> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  for (const candidate of candidates) {
    try {
      const stats = await stat(candidate);
      if (
        stats.isFile() &&
        (stats.mode & 0o111) !== 0 &&
        (stats.mode & 0o022) === 0 &&
        (stats.uid === 0 || stats.uid === euid)
      ) {
        return candidate;
      }
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

/**
 * Variables that make Git inspect a different repository, index, or attribute source than the
 * one discovered from the compilation root (for example `GIT_DIR=.git` set for a parent
 * repository). Configuration variables such as `GIT_CONFIG_GLOBAL` are kept: they select the
 * caller's own settings, including `safe.directory` and `core.attributesFile`.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.startsWith("GIT_") && !isGitConfigurationVariable(name)) continue;
    if (name === "LANG" || name === "LANGUAGE" || name.startsWith("LC_")) continue;
    environment[name] = value;
  }
  // Stable wording for the failure classification below; no prompts or optional index writes.
  environment.LC_ALL = "C";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function isGitConfigurationVariable(name: string): boolean {
  return (
    name === "GIT_CONFIG_GLOBAL" ||
    name === "GIT_CONFIG_SYSTEM" ||
    name === "GIT_CONFIG_NOSYSTEM" ||
    name === "GIT_CONFIG_COUNT" ||
    name === "GIT_CONFIG_PARAMETERS" ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(name)
  );
}

type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; notRepository: boolean; failure: PortableReadFailure };

async function runGit(args: readonly string[], maxBuffer: number): Promise<GitResult> {
  trustedGit ??= await findTrustedGitExecutable();
  const git = trustedGit;
  if (git === undefined) {
    return {
      ok: false,
      notRepository: false,
      failure: {
        message: "Git is required inside a Git worktree but was not found in a trusted location",
        reason: "git-evidence-unavailable",
      },
    };
  }
  const result = await new Promise<{ error: Error | null; stderr: string; stdout: string }>(
    (resolvePromise) => {
      execFile(
        git,
        [...args],
        {
          encoding: "utf8",
          env: gitEnvironment(),
          killSignal: "SIGKILL",
          maxBuffer,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) =>
          resolvePromise({ error, stdout: String(stdout), stderr: String(stderr) }),
      );
    },
  );
  if (result.error === null) return { ok: true, stdout: result.stdout };
  if (result.stderr.includes("detected dubious ownership")) {
    return {
      ok: false,
      notRepository: false,
      failure: {
        message: "Git refuses to inspect a worktree owned by another user",
        reason: "git-repository-untrusted",
      },
    };
  }
  if (/^fatal: not a git repository \(or any (?:of the )?parent/mu.test(result.stderr)) {
    return {
      ok: false,
      notRepository: true,
      failure: {
        message: "Git repository boundary could not be proven",
        reason: "git-evidence-unavailable",
      },
    };
  }
  return {
    ok: false,
    notRepository: false,
    failure: {
      message: (result.error as { killed?: boolean }).killed
        ? "Git repository evidence timed out"
        : "Git repository boundary could not be proven",
      reason: "git-evidence-unavailable",
    },
  };
}

type AnchoredGitBoundaryProof =
  | { ok: true; fingerprint: string; present: boolean }
  | { ok: false; failure: PortableReadFailure };

async function anchoredGitBoundaryFingerprint(
  directory: FileHandle,
): Promise<AnchoredGitBoundaryProof> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      procFdChild(directory.fd, ".git"),
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() && !before.isDirectory()) {
      return {
        ok: false,
        failure: {
          message: "Git boundary is not a regular file or directory",
          reason: "special-file",
        },
      };
    }
    const after = await handle.stat({ bigint: true });
    if (!hasStableFileIdentity(before, after)) {
      return {
        ok: false,
        failure: {
          message: "Git boundary identity changed while it was inspected",
          reason: "changed-during-read",
        },
      };
    }
    return { ok: true, present: true, fingerprint: `present:${statStamp(after)}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { ok: true, present: false, fingerprint: "absent" }
      : {
          ok: false,
          failure: {
            message: "Git boundary could not be inspected without following links",
            reason: code === "ELOOP" ? "symbolic-link" : undefined,
          },
        };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Evaluate the exact path with Git, including ancestor, info, and configured attributes. */
async function effectiveGitAttributeFailure(
  worktree: string,
  worktreePath: string,
): Promise<PortableReadFailure | undefined> {
  const result = await runGit(
    ["-C", worktree, "check-attr", "-z", "filter", "working-tree-encoding", "--", worktreePath],
    64 * 1024,
  );
  if (!result.ok) {
    return result.notRepository
      ? {
          message: "Effective Git attributes could not be evaluated safely",
          reason: "git-evidence-unavailable",
        }
      : result.failure;
  }
  const fields = result.stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length !== 6) {
    return {
      message: "Effective Git attribute output is malformed",
      reason: "git-evidence-unavailable",
    };
  }
  const values = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 3) {
    if (fields[index] !== worktreePath) {
      return {
        message: "Effective Git attribute path binding changed",
        reason: "git-evidence-unavailable",
      };
    }
    values.set(fields[index + 1], fields[index + 2]);
  }
  if (
    values.get("filter") !== "unspecified" ||
    values.get("working-tree-encoding") !== "unspecified"
  ) {
    return {
      message: "Effective Git content filters or working-tree encoding are not portable",
      reason: "git-filtered",
    };
  }
  return undefined;
}

interface EffectiveGitAttributes {
  filter?: "set" | "unset" | "unspecified";
  workingTreeEncoding?: "set" | "unset" | "unspecified";
  /** Macro names whose expansion may set a content filter or working-tree encoding. */
  macros: Set<string>;
}

/**
 * Apply one `.gitattributes` file outside a Git worktree. A line matters only when it can
 * affect `filter` or `working-tree-encoding`; it fails the read only when its pattern could
 * match `relativePath` and that match cannot be decided exactly.
 */
async function applyGitAttributes(
  directory: FileHandle,
  relativePath: string,
  state: EffectiveGitAttributes,
): Promise<PortableReadFailure | undefined> {
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
      return {
        message: "Git attribute evidence is not a stable regular file",
        reason: "git-filtered",
      };
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!hasStableFileIdentity(before, after)) {
      return {
        message: "Git attribute evidence changed while it was evaluated",
        reason: "changed-during-read",
      };
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { message: "Git attribute evidence is not strict UTF-8", reason: "git-filtered" };
    }
    const unprovable = (message: string): PortableReadFailure => ({
      message,
      reason: "git-filtered",
    });
    for (const rawLine of source.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const parsed = splitGitAttributeLine(line);
      if (parsed === undefined) {
        if (/(?:filter|working-tree-encoding)/u.test(line) || state.macros.size > 0) {
          return unprovable(
            "Quoted Git attribute patterns cannot be proven by the filesystem compiler",
          );
        }
        continue;
      }
      const { pattern, fields } = parsed;
      const relevant = fields.some(
        (token) => isPortableAttributeToken(token) || state.macros.has(attributeTokenName(token)),
      );
      if (pattern.startsWith("[attr]")) {
        if (relevant) state.macros.add(pattern.slice("[attr]".length));
        continue;
      }
      // Git ignores negative patterns in attribute files.
      if (!relevant || pattern.startsWith("!")) continue;
      const match = gitAttributePatternMatch(pattern, relativePath);
      if (match === "no") continue;
      if (match === "unknown") {
        return unprovable("Git attribute pattern cannot be proven by the filesystem compiler");
      }
      for (const token of fields) {
        if (state.macros.has(attributeTokenName(token))) {
          return unprovable("Git attribute macros cannot be proven by the filesystem compiler");
        }
        applyAttributeToken(token, state);
      }
    }
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? undefined
      : {
          message: "Git attribute evidence could not be read without following links",
          reason: code === "ELOOP" ? "symbolic-link" : undefined,
        };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Split a pattern from its attributes, decoding Git's C-style quoted patterns. */
function splitGitAttributeLine(line: string): { pattern: string; fields: string[] } | undefined {
  const fieldsOf = (rest: string) => rest.split(/[\t ]+/u).filter((field) => field.length > 0);
  if (!line.startsWith('"')) {
    const [pattern, ...fields] = line.split(/[\t ]+/u);
    return { pattern, fields };
  }
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      const rest = line.slice(index + 1);
      if (rest.length > 0 && !/^[\t ]/u.test(rest)) return undefined;
      try {
        const pattern = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
        return { pattern, fields: fieldsOf(rest) };
      } catch {
        return undefined;
      }
    }
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const next = line[++index];
    const simple: Record<string, number> = {
      '"': 0x22,
      "\\": 0x5c,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
    };
    if (next !== undefined && Object.hasOwn(simple, next)) {
      bytes.push(simple[next]);
    } else if (/^[0-3][0-7]{2}$/u.test(line.slice(index, index + 3))) {
      bytes.push(Number.parseInt(line.slice(index, index + 3), 8));
      index += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function attributeTokenName(token: string): string {
  return token.replace(/^[!-]/u, "").split("=", 1)[0];
}

function applyAttributeToken(token: string, state: EffectiveGitAttributes): void {
  const rawName = attributeTokenName(token);
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

/**
 * Decide whether a Git attribute pattern matches `relativePath`. Wildcards (`*`, `?`) and a
 * double asterisk forming a whole leading, trailing, or middle path component are matched
 * exactly. Bracket expressions, escapes, and other double asterisks are over-approximated: a
 * pattern that cannot match even then is "no", otherwise "unknown".
 */
function gitAttributePatternMatch(pattern: string, relativePath: string): "yes" | "no" | "unknown" {
  if (pattern.length === 0 || pattern.endsWith("/")) return "no";
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  const candidate =
    anchored || body.includes("/") ? relativePath : (relativePath.split("/").at(-1) ?? "");
  const glob = globToRegExp(body);
  if (!glob.regexp.test(candidate)) return "no";
  return glob.exact ? "yes" : "unknown";
}

function globToRegExp(pattern: string): { regexp: RegExp; exact: boolean } {
  let source = "^";
  let exact = true;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      let end = index;
      while (pattern[end] === "*") end++;
      const atStart = index === 0 || pattern[index - 1] === "/";
      const atEnd = end === pattern.length || pattern[end] === "/";
      if (atStart && atEnd && end - index === 2) {
        if (end === pattern.length) {
          source += ".*";
        } else {
          // `**/` matches zero or more whole directories.
          source += "(?:.*/)?";
          end++;
        }
      } else {
        // Git treats these asterisks like `*`; `.*` is a superset.
        source += ".*";
        exact = false;
      }
      index = end - 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      exact = false;
      let end = index + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") end++;
      if (end >= pattern.length) {
        source += ".*";
        break;
      }
      source += ".";
      index = end;
    } else if (character === "\\") {
      exact = false;
      if (index + 1 >= pattern.length) {
        source += ".*";
        break;
      }
      source += ".";
      index++;
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return { regexp: new RegExp(`${source}$`, "u"), exact };
}

/** Git LFS never treats a blob of this size or larger as a pointer. */
const GIT_LFS_POINTER_MAX_BYTES = 1024;
/** Pointer version identifiers that Git LFS accepts, including legacy aliases. */
const GIT_LFS_POINTER_VERSION =
  /^version[ \t]+(?:https?:\/\/git-lfs\.github\.com\/spec\/v1|https?:\/\/hawser\.github\.com\/spec\/v1|https?:\/\/git-media\.io\/v\/2)[ \t]*$/iu;

/**
 * Detect Git LFS pointer files by their spec shape: a small text blob whose first line names a
 * pointer version. Malformed or reordered keys after that line are still rejected, so truncated or
 * hand-edited pointers never publish as asset bytes, while ordinary text that merely mentions
 * Git LFS (for example `git-lfs` in a namespace or prose) remains readable.
 */
export function looksLikeGitLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength >= GIT_LFS_POINTER_MAX_BYTES) return false;
  const text = new TextDecoder().decode(bytes);
  const firstLine = text.replace(/^[﻿\s]+/u, "").split(/\r?\n/u, 1)[0] ?? "";
  return GIT_LFS_POINTER_VERSION.test(firstLine);
}

function unsafeFilesystemFileReason(
  stats: BigIntStats,
  maxBytes: number,
): PortableReadFailure | undefined {
  if (!stats.isFile()) {
    return {
      message: "Only regular files can be read; found a special filesystem entry",
      reason: "special-file",
    };
  }
  if (stats.nlink !== 1n) {
    return {
      message: "Hard-linked files cannot be read; replace the link with a copy",
      reason: "hard-linked",
    };
  }
  if ((stats.mode & 0o111n) !== 0n) {
    return {
      message: "Executable files cannot be read; clear the executable permission bits",
      reason: "executable",
    };
  }
  if (stats.size > BigInt(maxBytes)) {
    return { message: "File exceeds the read size limit", reason: "too-large" };
  }
  if (stats.size > 0n && stats.blocks * 512n < stats.size) {
    return {
      message:
        "Sparse or filesystem-compressed files cannot be read; rewrite the file without holes",
      reason: "special-file",
    };
  }
  return undefined;
}

function unsupported(
  file: PortableAssetFileDescriptor,
  message: string,
  reason?: PortableReadFailureReason,
): TopikAssetDiagnostic {
  return unsupportedPath(file.path, message, reason);
}

function hasPortableMode(file: PortableAssetFileDescriptor): boolean {
  if (file.source === "git" || file.source === "filesystem") return file.mode === "100644";
  if (file.source === "archive") return file.mode === "0644";
  return file.mode === "100644" || file.mode === "0644";
}

function procFdChild(parentFd: number, component: string): string {
  return `/proc/self/fd/${parentFd}/${component}`;
}

function unsupportedPath(
  path: string,
  message: string,
  reason?: PortableReadFailureReason,
): TopikAssetDiagnostic {
  const diagnostic = topikAssetDiagnostic("TOPIK_ASSET_FILE_TYPE_UNSUPPORTED", message, {
    descriptorVersion: TOPIK_PATH_VERSION,
    location: { path },
    recovery: "preserve-read-only",
  });
  if (reason !== undefined) failureReasons.set(diagnostic, reason);
  return diagnostic;
}

/** Keep the mutation evidence identical for bytes, Git boundaries, and Git attributes. */
function hasStableFileIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.ctimeNs === after.ctimeNs &&
    before.mtimeNs === after.mtimeNs
  );
}
