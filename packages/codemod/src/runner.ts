import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { transformMintlify, type TransformWarning } from "./transforms/mintlify";

export interface RunOptions {
  dir: string;
  dryRun: boolean;
  keepExtension: boolean;
}

export interface FileResult {
  relativePath: string;
  newRelativePath?: string;
  warnings: TransformWarning[];
  changed: boolean;
}

export interface RunSummary {
  files: FileResult[];
  filesChanged: number;
  warnings: number;
}

export async function runMintlify(options: RunOptions): Promise<RunSummary> {
  const files: FileResult[] = [];
  let filesChanged = 0;
  let warnings = 0;

  for await (const absPath of walk(options.dir)) {
    if (!absPath.endsWith(".mdx") && !absPath.endsWith(".md")) continue;
    const source = await readFile(absPath, "utf-8");
    const result = transformMintlify(source);
    const rel = relative(options.dir, absPath);

    const fileResult: FileResult = {
      relativePath: rel,
      warnings: result.warnings,
      changed: result.changed,
    };
    warnings += result.warnings.length;

    if (result.changed) filesChanged++;

    if (!options.dryRun && result.changed) {
      await writeFile(absPath, result.content);
    }

    if (!options.keepExtension && absPath.endsWith(".mdx")) {
      const newPath = absPath.slice(0, -4) + ".md";
      fileResult.newRelativePath = relative(options.dir, newPath);
      if (!options.dryRun) {
        await rename(absPath, newPath);
      }
    }

    files.push(fileResult);
  }

  return { files, filesChanged, warnings };
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
