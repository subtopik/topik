import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMMUTABLE_TAG_PATTERN } from "./constants.mjs";

const runFile = promisify(execFile);

export async function verifyGitTag(workspaceRoot, tag, expectedTag, { run = runGit } = {}) {
  if (typeof tag !== "string" || !IMMUTABLE_TAG_PATTERN.test(tag) || tag !== expectedTag) {
    throw new Error("release tag is unsafe or does not match the checked-in plan");
  }
  const taggedCommit = await run(
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    workspaceRoot,
  );
  const checkedOutCommit = await run(["rev-parse", "--verify", "HEAD^{commit}"], workspaceRoot);
  if (!/^[0-9a-f]{40,64}$/u.test(taggedCommit) || taggedCommit !== checkedOutCommit) {
    throw new Error("release tag does not dereference to the checked-out commit");
  }
}

async function runGit(arguments_, cwd) {
  try {
    const { stdout } = await runFile("git", arguments_, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    return stdout.trim();
  } catch {
    throw new Error("release tag could not be verified");
  }
}
