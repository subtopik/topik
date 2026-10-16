import { chmod, lstat, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MigrationEdit {
  path: string;
  destination: string;
  source: string;
  content: string;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Publish a planned migration with rollback for ordinary I/O failures.
 * Requires a serialized invocation; this is not a crash-atomic filesystem transaction.
 */
export async function publishMigration(edits: readonly MigrationEdit[]): Promise<string[]> {
  const staged: Array<
    MigrationEdit & {
      directory: string;
      candidate: string;
      backup: string;
      moved: boolean;
      published: boolean;
    }
  > = [];
  try {
    // Prepare every replacement before changing any source or destination.
    for (const edit of edits) {
      const directory = await mkdtemp(join(dirname(edit.path), ".topik-codemod-"));
      const entry = {
        ...edit,
        directory,
        candidate: join(directory, "candidate"),
        backup: join(directory, "original"),
        moved: false,
        published: false,
      };
      staged.push(entry);
      const mode = (await stat(edit.path)).mode & 0o777;
      await writeFile(entry.candidate, edit.content, { encoding: "utf8", mode });
      await chmod(entry.candidate, mode);
    }
    for (const edit of staged) {
      if ((await readFile(edit.path, "utf8")) !== edit.source)
        throw new Error(`Source changed during migration: ${edit.path}`);
      if (edit.destination !== edit.path && (await pathExists(edit.destination)))
        throw new Error(`Destination already exists: ${edit.destination}`);
    }
    for (const entry of staged) {
      await rename(entry.path, entry.backup);
      entry.moved = true;
      await rename(entry.candidate, entry.destination);
      entry.published = true;
    }
  } catch (error) {
    const failures: string[] = [];
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.published) await rename(entry.destination, entry.candidate);
        if (entry.moved) await rename(entry.backup, entry.path);
      } catch (rollbackError) {
        failures.push(`${entry.directory}: ${String(rollbackError)}`);
      }
    }
    // Keep every backup if rollback itself fails, and identify recovery locations.
    if (failures.length)
      throw new Error(
        `Migration failed (${String(error)}); rollback incomplete. Recovery files retained: ${failures.join("; ")}`,
      );
    for (const entry of staged) await rm(entry.directory, { recursive: true, force: true });
    throw error;
  }
  const warnings: string[] = [];
  for (const entry of staged) {
    try {
      await rm(entry.directory, { recursive: true, force: true });
    } catch (error) {
      warnings.push(
        `Migration completed, but temporary files remain at ${entry.directory}: ${String(error)}`,
      );
    }
  }
  return warnings;
}
