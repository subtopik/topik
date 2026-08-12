#!/usr/bin/env node

import { run } from "@drizzle-team/brocli";
import { compile } from "./compile";
import { dev } from "./dev";
import { formatPublicCliError } from "./errors";
import { lint } from "./lint";
import { validate } from "./validate";

try {
  await run([compile, dev, lint, validate], {
    name: "topik",
    description: "Topik CLI",
  });
} catch (error) {
  console.error(formatPublicCliError(error));
  process.exitCode = 1;
}
