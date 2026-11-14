#!/usr/bin/env node

import { resolve } from "node:path";
import { boolean, command, positional, run } from "@drizzle-team/brocli";
import { version } from "../package.json";
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

    const dry = options.dryRun;
    for (const file of summary.files) {
      const rename = file.newRelativePath ? ` → ${file.newRelativePath}` : "";
      if (file.changed && file.contentChanged)
        console.log(`  ${dry ? "would convert" : "converted"} ${file.relativePath}${rename}`);
      else if (file.changed)
        console.log(`  ${dry ? "would rename" : "renamed"} ${file.relativePath}${rename}`);
      else if (file.error !== undefined || file.warnings.length > 0) {
        const details = [
          ...(file.error !== undefined ? ["error"] : []),
          ...(file.warnings.length > 0 ? [`${file.warnings.length} warning(s)`] : []),
        ];
        console.log(`  skipped ${file.relativePath} (${details.join(", ")})`);
      }
    }

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

    for (const notice of summary.notices) console.error(`ℹ ${notice}`);

    const tense = dry ? "would convert" : "converted";
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
  version,
});
