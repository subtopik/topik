#!/usr/bin/env node

import { run } from "@drizzle-team/brocli";
import { compile } from "./compile";
import { CliError } from "./errors";
import { validate } from "./validate";

try {
  await run([compile, validate], {
    name: "topik",
    description: "Topik CLI",
  });
} catch (error) {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
