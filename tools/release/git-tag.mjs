import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMMUTABLE_TAG_PATTERN } from "./constants.mjs";

const runFile = promisify(execFile);

export async function verifyGitTag(
  workspaceRoot,
  tag,
  expectedTag,
  { run = runGit, eventRef, eventSha } = {},
) {
  if (typeof tag !== "string" || !IMMUTABLE_TAG_PATTERN.test(tag) || tag !== expectedTag) {
    throw new Error("release tag is unsafe or does not match the checked-in plan");
  }
  if (eventRef !== `refs/tags/${tag}`) {
    throw new Error("workflow event ref does not match the immutable release tag");
  }
  if (typeof eventSha !== "string" || !/^[0-9a-f]{40,64}$/u.test(eventSha)) {
    throw new Error("workflow event SHA is missing or malformed");
  }
  const taggedCommit = await run(
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    workspaceRoot,
  );
  const checkedOutCommit = await run(["rev-parse", "--verify", "HEAD^{commit}"], workspaceRoot);
  if (!/^[0-9a-f]{40,64}$/u.test(taggedCommit) || taggedCommit !== checkedOutCommit) {
    throw new Error("release tag does not dereference to the checked-out commit");
  }
  if (eventSha !== taggedCommit) {
    throw new Error("workflow event SHA does not match the immutable release tag");
  }
  return taggedCommit;
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
