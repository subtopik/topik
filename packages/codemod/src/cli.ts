#!/usr/bin/env node

import { resolve } from "node:path";
import { boolean, command, positional, run } from "@drizzle-team/brocli";
import { version } from "../package.json";
import { isMigrationInput, runMintlify } from "./runner";

const MANIFEST_GUIDE_URL = "https://github.com/subtopik/topik/blob/main/docs/resources/manifest.md";

const mintlify = command({
  name: "mintlify",
  desc: "Convert supported Mintlify components to Topik content directives",
  options: {
    dir: positional("path")
      .desc("Path to the Mintlify content directory, or to a single .md or .mdx file")
      .default("."),
    dryRun: boolean("dry-run").desc("Preview changes without writing files").default(false),
    diff: boolean("diff")
      .desc("Print a unified diff of the changes without writing files")
      .default(false),
    keepExtension: boolean("keep-extension")
      .desc("Keep .mdx file extension after conversion (default: rename to .md)")
      .default(false),
  },
  handler: async (options) => {
    const dir = resolve(options.dir);
    if (!(await isMigrationInput(dir))) {
      console.error("Not a directory or a .md or .mdx file");
      process.exit(1);
    }

    const diff = options.diff === true;
    const summary = await runMintlify({
      dir,
      dryRun: options.dryRun,
      keepExtension: options.keepExtension,
      diff,
    });

    const dry = options.dryRun || diff;
    // With --diff, stdout carries only the patch, so progress moves to stderr.
    const log = diff ? console.error : console.log;
    for (const file of summary.files) {
      if (file.diff) process.stdout.write(file.diff);
      const rename = file.newRelativePath ? ` → ${file.newRelativePath}` : "";
      if (file.changed && file.contentChanged)
        log(`  ${dry ? "would convert" : "converted"} ${file.relativePath}${rename}`);
      else if (file.changed)
        log(`  ${dry ? "would rename" : "renamed"} ${file.relativePath}${rename}`);
      else if (file.error !== undefined || file.warnings.length > 0) {
        const details = [
          ...(file.error !== undefined ? ["error"] : []),
          ...(file.warnings.length > 0 ? [`${file.warnings.length} warning(s)`] : []),
        ];
        log(`  skipped ${file.relativePath} (${details.join(", ")})`);
      }
    }
    const navigation = summary.navigation;
    if (navigation?.diff) process.stdout.write(navigation.diff);
    if (navigation?.changed)
      log(`  ${dry ? "would write" : "wrote"} ${navigation.output} from ${navigation.source}`);

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
    if (navigation?.error !== undefined) {
      console.error(`✗ ${navigation.output} — ${navigation.error}`);
      errors++;
    }
    for (const warning of navigation?.warnings ?? [])
      console.error(`⚠ ${navigation?.source} — ${warning}`);

    for (const notice of summary.notices) console.error(`ℹ ${notice}`);
    if (navigation?.changed)
      console.error(
        `ℹ topik lint needs a project manifest (.topik.yaml) that lists ${navigation.output} as a wiki source: ${MANIFEST_GUIDE_URL}`,
      );
    if (diff && (summary.files.some((file) => file.diff) || navigation?.diff))
      console.error(
        "ℹ Paths in the patch are relative to the converted directory. In a Git repository, apply it with git apply --directory=<that directory's path from the repository root>",
      );

    const tense = dry ? "would convert" : "converted";
    log(`${errors === 0 ? "✓ " : ""}${tense} ${summary.filesChanged} file(s)`);
    if (summary.warnings > 0) {
      log(`⚠ ${summary.warnings} warning(s)`);
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
