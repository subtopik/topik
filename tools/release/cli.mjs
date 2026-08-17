#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndVerifyArchives, prepareArchives } from "./archive.mjs";
import { verifyGitTag } from "./git-tag.mjs";
import { loadReleaseContext } from "./plan.mjs";
import { NpmRegistry, promoteAlpha, publishCandidate } from "./registry.mjs";
import { PUBLISH_WORKFLOW_PATH, SOURCE_REPOSITORY } from "./constants.mjs";

const workspaceRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export function parseCliArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length === 0)
    throw new Error("missing release command");
  const [command, ...tokens] = arguments_;
  if (!["validate", "verify-tag", "prepare", "publish", "promote"].includes(command)) {
    throw new Error("unknown release command");
  }
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      typeof flag !== "string" ||
      !/^--[a-z]+(?:-[a-z]+)*$/u.test(flag) ||
      typeof value !== "string" ||
      value.startsWith("--") ||
      Object.hasOwn(options, flag)
    ) {
      throw new Error("malformed or duplicate release argument");
    }
    options[flag] = value;
  }

  const allowed = {
    validate: [],
    "verify-tag": ["--event-ref", "--event-sha", "--tag"],
    prepare: ["--artifacts"],
    publish: ["--artifacts", "--event-ref", "--event-sha", "--mode", "--tag"],
    promote: ["--artifacts", "--consumer-gate", "--event-ref", "--event-sha", "--tag"],
  }[command];
  const fields = Object.keys(options).sort((left, right) => left.localeCompare(right));
  const expected = [...allowed].sort((left, right) => left.localeCompare(right));
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index])
  ) {
    throw new Error("release command has missing or unexpected arguments");
  }
  return { command, options };
}

export async function main(arguments_, hooks = {}) {
  const { command, options } = parseCliArguments(arguments_);
  const root = hooks.workspaceRoot ?? workspaceRoot;
  const context = await loadReleaseContext(root);
  if (command === "validate") return;

  if (command === "verify-tag") {
    await verifyGitTag(root, options["--tag"], context.plan.gitTag, {
      ...hooks.git,
      eventRef: options["--event-ref"],
      eventSha: options["--event-sha"],
    });
    return;
  }
  if (command === "prepare") {
    await prepareArchives(root, options["--artifacts"], context, hooks.archive);
    return;
  }

  const gitCommit = await verifyGitTag(root, options["--tag"], context.plan.gitTag, {
    ...hooks.git,
    eventRef: options["--event-ref"],
    eventSha: options["--event-sha"],
  });
  const source = {
    repository: SOURCE_REPOSITORY,
    workflow: PUBLISH_WORKFLOW_PATH,
    gitRef: options["--event-ref"],
    gitCommit,
  };
  const archives = await loadAndVerifyArchives(root, options["--artifacts"], context);
  const registry = hooks.registry ?? new NpmRegistry();
  if (command === "publish") {
    await publishCandidate({
      mode: options["--mode"],
      plan: context.plan,
      archives,
      registry,
      source,
    });
    return;
  }
  if (options["--consumer-gate"] !== "validated") {
    throw new Error("promotion requires explicit private consumer validation");
  }
  await promoteAlpha({ plan: context.plan, archives, registry, source });
}

export function publicReleaseError(error, root = workspaceRoot) {
  if (!(error instanceof Error)) return "Release operation failed.";
  const firstLine = error.message.split(/\r?\n/u, 1)[0];
  const redacted = firstLine.split(root).join("<workspace>");
  return redacted.length <= 500 ? redacted : "Release operation failed.";
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(() => {
      console.log("Release operation completed successfully.");
    })
    .catch((error) => {
      console.error(publicReleaseError(error));
      process.exitCode = 1;
    });
}
