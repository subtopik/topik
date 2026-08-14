import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { discoverSchemaTargets } from "./schema-targets.mjs";

test("discovers every numeric resource version without treating tests as entries", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "topik-schema-targets-"));

  try {
    const resourceDirectory = join(packageDirectory, "src", "wiki");
    await mkdir(resourceDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(resourceDirectory, "v1.json"), "{}\n"),
      writeFile(join(resourceDirectory, "v1.ts"), "export interface Wiki {}\n"),
      writeFile(join(resourceDirectory, "v1.test.ts"), "\n"),
      writeFile(join(resourceDirectory, "v2.json"), "{}\n"),
      writeFile(join(resourceDirectory, "v10.json"), "{}\n"),
    ]);

    await expect(discoverSchemaTargets(packageDirectory)).resolves.toEqual([
      {
        resource: "wiki",
        version: "v1",
        schema: "src/wiki/v1.json",
        types: "src/wiki/v1.ts",
      },
      {
        resource: "wiki",
        version: "v2",
        schema: "src/wiki/v2.json",
        types: "src/wiki/v2.ts",
      },
      {
        resource: "wiki",
        version: "v10",
        schema: "src/wiki/v10.json",
        types: "src/wiki/v10.ts",
      },
    ]);
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test("rejects generated versioned types without a source schema", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "topik-schema-targets-"));

  try {
    const resourceDirectory = join(packageDirectory, "src", "asset");
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(join(resourceDirectory, "v2.ts"), "export interface Asset {}\n");

    await expect(discoverSchemaTargets(packageDirectory)).rejects.toThrow(
      "Generated types have no matching schema: src/asset/v2.ts",
    );
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test("rejects invalid resource directory names", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "topik-schema-targets-"));

  try {
    await mkdir(join(packageDirectory, "src", "Invalid_Resource"), { recursive: true });

    await expect(discoverSchemaTargets(packageDirectory)).rejects.toThrow(
      "Invalid schema resource directory: src/Invalid_Resource",
    );
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test("rejects non-versioned schema files", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "topik-schema-targets-"));

  try {
    const resourceDirectory = join(packageDirectory, "src", "asset");
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(join(resourceDirectory, "schema.json"), "{}\n");

    await expect(discoverSchemaTargets(packageDirectory)).rejects.toThrow(
      "Invalid versioned schema filename: src/asset/schema.json",
    );
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});
