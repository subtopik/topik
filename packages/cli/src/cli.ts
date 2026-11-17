#!/usr/bin/env node

import { run, type BroCliEvent } from "@drizzle-team/brocli";
import { version } from "../package.json";
import { compile } from "./compile";
import { dev } from "./dev";
import { formatPublicCliError } from "./errors";
import { format } from "./format";
import { init } from "./init";
import { lint } from "./lint";
import { migrate } from "./migrate";
import { validate } from "./validate";

/**
 * Route command handler failures through the public error formatter. brocli
 * catches handler errors itself, so without this theme it would print raw
 * `error.message` values (absolute paths, system error text) and exit 1.
 */
function theme(event: BroCliEvent): boolean {
  if (event.type === "error" && event.violation === "unknown_error") {
    console.error(formatPublicCliError(event.error));
    return true;
  }
  return false;
}

try {
  await run([compile, dev, format, init, lint, migrate, validate], {
    name: "topik",
    description: "Topik CLI",
    version,
    theme,
  });
} catch (error) {
  console.error(formatPublicCliError(error));
  process.exitCode = 1;
}
