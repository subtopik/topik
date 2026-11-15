import { resolve } from "node:path";
import { command, positional, string } from "@drizzle-team/brocli";
import { isErrorDiagnostic, lint as lintContent, type LinkValidationPolicy } from "@topik/core";
import { printDiagnostics } from "../diagnostics";
import { PublicCliError, withProjectPlatformRequirement } from "../errors";

export const lint = command({
  name: "lint",
  desc: "Lint Topik source content without writing compiled resources. Requires Linux.",
  options: {
    dir: positional("dir").desc("Project directory containing .topik.yaml").default("."),
    links: string("links")
      .desc("How unresolved wiki links and local guide fragments are handled")
      .enum("error", "warning", "off")
      .default("error"),
  },
  handler: async (options) => {
    const links = options.links as LinkValidationPolicy;
    const { diagnostics } = await lintContent({
      dir: resolve(options.dir),
      validation: { links },
    }).catch((error: unknown) => {
      throw withProjectPlatformRequirement(error);
    });
    printDiagnostics(diagnostics);

    const errors = diagnostics.filter(isErrorDiagnostic);
    if (errors.length > 0) {
      console.error(`${errors.length} lint error(s)`);
      throw new PublicCliError("lint-failed");
    }

    const warnings = diagnostics.filter((diagnostic) => diagnostic.level === "warning").length;
    console.log(`Lint passed${warnings > 0 ? ` with ${warnings} warning(s)` : ""}`);
  },
});
