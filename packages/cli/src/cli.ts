#!/usr/bin/env node

import { run } from "@drizzle-team/brocli";
import { compile } from "./compile";
import { dev } from "./dev";
import { CliError } from "./errors";
import { validate } from "./validate";

try {
  await run([compile, dev, validate], {
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
