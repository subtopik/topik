#!/usr/bin/env node

import { run } from "@drizzle-team/brocli";
import { compile } from "./compile";
import { validate } from "./validate";

await run([compile, validate], {
  name: "topik",
  description: "Topik content management CLI",
});
