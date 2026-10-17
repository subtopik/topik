#!/usr/bin/env node

import { resolve } from "node:path";
import { boolean, command, positional, run } from "@drizzle-team/brocli";
import { isDirectory, runMintlify } from "./runner";

const mintlify = command({
  name: "mintlify",
  desc: "Convert supported Mintlify components to Topik content directives",
  options: {
    dir: positional("dir").desc("Path to the Mintlify content directory").default("."),
    dryRun: boolean("dry-run").desc("Preview changes without writing files").default(false),
    keepExtension: boolean("keep-extension")
      .desc("Keep .mdx file extension after conversion (default: rename to .md)")
      .default(false),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    if (!(await isDirectory(dir))) {
      console.error(`Not a directory: ${dir}`);
      process.exit(1);
    }

    const summary = await runMintlify({
      dir,
      dryRun: options.dryRun,
      keepExtension: options.keepExtension,
    });

    let errors = 0;
    for (const file of summary.files) {
      if (file.error !== undefined) {
        console.error(`✗ ${file.relativePath} — ${file.error}`);
        errors++;
      }
      for (const warning of file.warnings) {
        console.error(
          `⚠ ${file.relativePath}:${warning.line}:${warning.column} — ${warning.message}`,
        );
      }
    }

    const tense = options.dryRun ? "would convert" : "converted";
    console.log(`${errors === 0 ? "✓ " : ""}${tense} ${summary.filesChanged} file(s)`);
    if (summary.warnings > 0) {
      console.log(`⚠ ${summary.warnings} warning(s)`);
    }
    if (errors > 0) {
      console.error(`✗ ${errors} file(s) failed`);
      process.exitCode = 1;
    }
  },
});

await run([mintlify], {
  name: "topik-codemod",
  description: "Codemods for migrating content to Topik",
});
