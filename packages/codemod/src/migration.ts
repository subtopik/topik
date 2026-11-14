import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MigrationEdit {
  path: string;
  destination: string;
  source: string;
  content: string;
}

/** Prefix of the hidden staging directories created next to each migrated file. */
export const STAGING_PREFIX = ".topik-codemod-";

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
 * Requires a serialized invocation; this is not a crash-atomic filesystem transaction,
 * but a source is never absent from the tree: in-place edits are a single atomic
 * rename over the source, and a renamed file is published before its source is removed.
 * An interrupted run can leave a staging directory and, for a rename, both names.
 */
export async function publishMigration(edits: readonly MigrationEdit[]): Promise<string[]> {
  const staged: Array<
    MigrationEdit & {
      directory: string;
      candidate: string;
      backup: string;
      published: boolean;
      removed: boolean;
    }
  > = [];
  try {
    // Prepare every replacement before changing any source or destination.
    for (const edit of edits) {
      const directory = await mkdtemp(join(dirname(edit.path), STAGING_PREFIX));
      const entry = {
        ...edit,
        directory,
        candidate: join(directory, "candidate"),
        backup: join(directory, "original"),
        published: false,
        removed: false,
      };
      staged.push(entry);
      const mode = (await stat(edit.path)).mode & 0o777;
      await writeFile(entry.candidate, edit.content, { encoding: "utf8", mode });
      await chmod(entry.candidate, mode);
      // The backup is the original inode where possible, so rollback restores it exactly.
      await link(edit.path, entry.backup).catch(async () => {
        await copyFile(edit.path, entry.backup);
        await chmod(entry.backup, mode);
      });
    }
    for (const edit of staged) {
      if ((await readFile(edit.path, "utf8")) !== edit.source)
        throw new Error(`Source changed during migration: ${edit.path}`);
      if (edit.destination !== edit.path && (await pathExists(edit.destination)))
        throw new Error(`Destination already exists: ${edit.destination}`);
    }
    for (const entry of staged) {
      await rename(entry.candidate, entry.destination);
      entry.published = true;
      if (entry.destination !== entry.path) {
        await unlink(entry.path);
        entry.removed = true;
      }
    }
  } catch (error) {
    const failures: string[] = [];
    for (const entry of [...staged].reverse()) {
      try {
        if (entry.destination === entry.path) {
          if (entry.published) await rename(entry.backup, entry.path);
        } else {
          if (entry.removed) await rename(entry.backup, entry.path);
          if (entry.published) await rename(entry.destination, entry.candidate);
        }
      } catch (rollbackError) {
        failures.push(`${entry.directory}: ${String(rollbackError)}`);
      }
    }
    // Keep every backup if rollback itself fails, and identify recovery locations.
    if (failures.length)
      throw new Error(
        `Migration failed (${String(error)}); rollback incomplete. Recovery files retained: ${failures.join("; ")}`,
        { cause: error },
      );
    // Cleanup is best-effort after restoring sources; preserve the migration failure.
    for (const entry of staged)
      await rm(entry.directory, { recursive: true, force: true }).catch(() => {});
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
