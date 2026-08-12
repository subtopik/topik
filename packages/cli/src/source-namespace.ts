import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix, relative, resolve, sep } from "node:path";
import {
  AssetCompilationError,
  validateStableSourceNamespace,
  type AssetCompilationOptions,
} from "@topik/core";
import { CliError } from "./errors";

const execFileAsync = promisify(execFile);

export function requiresSourceNamespace(error: unknown): error is AssetCompilationError {
  return (
    error instanceof AssetCompilationError &&
    error.diagnostics.some(
      (diagnostic) => diagnostic.id === "TOPIK_ASSET_SOURCE_NAMESPACE_REQUIRED",
    )
  );
}

export function sourceNamespaceOptions(
  value: string | undefined,
): AssetCompilationOptions | undefined {
  if (value === undefined) return undefined;
  const validation = validateStableSourceNamespace(value);
  if (!validation.ok) throw new CliError("--source-namespace must be normalized portable text");
  return { sourceNamespace: validation.value };
}

/** Derive only after automatic discovery proves that an Asset needs a namespace. */
export async function deriveGitSourceNamespace(dir: string): Promise<string> {
  let worktree: string;
  let remotes: string[];
  try {
    worktree = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    remotes = (await git(dir, ["remote"])).split(/\r?\n/u).filter(Boolean).sort();
  } catch {
    throw namespaceRequired();
  }
  const remoteName = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : undefined;
  if (remoteName === undefined) throw namespaceRequired();
  let remote: string;
  try {
    remote = (await git(dir, ["remote", "get-url", remoteName])).trim();
  } catch {
    throw namespaceRequired();
  }
  const identity = normalizeRemote(remote);
  if (identity === undefined) throw namespaceRequired();
  const rootRelative = relative(resolve(worktree), resolve(dir)).split(sep).join(posix.sep);
  if (rootRelative.startsWith("../") || rootRelative === "..") throw namespaceRequired();
  const namespace = `topik-git-v1:${identity}#${rootRelative || "."}`;
  const validation = validateStableSourceNamespace(namespace);
  if (!validation.ok) throw namespaceRequired();
  return validation.value;
}

function normalizeRemote(value: string): string | undefined {
  const scp = value.includes("://") ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(value);
  const candidate = scp !== null ? `ssh://${scp[1]}/${scp[2]}` : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:" && url.protocol !== "git:")
    return undefined;
  if (
    url.hostname.length === 0 ||
    url.password !== "" ||
    (url.protocol === "https:" && url.username !== "") ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }
  const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (
    path.length === 0 ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return undefined;
  }
  const port =
    url.port &&
    !(
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "ssh:" && url.port === "22")
    )
      ? `:${url.port}`
      : "";
  return `${url.hostname.toLowerCase()}${port}/${path}`;
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return stdout;
}

function namespaceRequired(): CliError {
  return new CliError(
    "Automatic local Assets require --source-namespace because no stable Git remote identity could be derived",
  );
}
