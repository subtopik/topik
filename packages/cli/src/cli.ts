#!/usr/bin/env node

import { run } from "@drizzle-team/brocli";
import { CompileError } from "@topik/core";
import { compile } from "./compile";
import { dev } from "./dev";
import { CliError } from "./errors";
import { lint } from "./lint";
import { validate } from "./validate";

try {
  await run([compile, dev, lint, validate], {
    name: "topik",
    description: "Topik CLI",
  });
} catch (error) {
  if (error instanceof CliError || error instanceof CompileError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
