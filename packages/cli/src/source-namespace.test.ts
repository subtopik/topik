import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { CliError } from "./errors";
import { deriveGitSourceNamespace } from "./source-namespace";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Git-backed source namespaces", () => {
  test("excludes checkout path, transport, branch, and commit", async () => {
    const first = await repository("alpha", "https://example.com/acme/content.git");
    const second = await repository("beta", "git@example.com:acme/content.git");

    const before = await deriveGitSourceNamespace(join(first, "docs"));
    const fromOtherCheckout = await deriveGitSourceNamespace(join(second, "docs"));
    await git(first, ["symbolic-ref", "HEAD", "refs/heads/renamed"]);
    await git(first, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const after = await deriveGitSourceNamespace(join(first, "docs"));

    expect(before).toBe("topik-git-v1:example.com/acme/content#docs");
    expect(fromOtherCheckout).toBe(before);
    expect(after).toBe(before);
  });

  test("fails visibly when no stable remote is available", async () => {
    const dir = await repository("main");
    await expect(deriveGitSourceNamespace(dir)).rejects.toBeInstanceOf(CliError);
  });
});

async function repository(branch: string, remote?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "topik-source-namespace-"));
  directories.push(dir);
  await git(dir, ["init", "--initial-branch", branch]);
  await mkdir(join(dir, "docs"));
  if (remote !== undefined) await git(dir, ["remote", "add", "origin", remote]);
  return dir;
}

async function git(dir: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", dir, ...args]);
}
