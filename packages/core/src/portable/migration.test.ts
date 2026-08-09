import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { migrateLegacyDigestOutput } from "./migration";

describe("legacy digest-output migration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-asset-migration-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("rewrites schema slots, preserves an exact backup, and is retry-stable", async () => {
    const fixture = join(import.meta.dirname, "fixtures", "migration");
    const bytes = Buffer.from("portable bytes\n");
    const input = await readFile(join(fixture, "legacy-output.json"));

    const first = await migrateLegacyDigestOutput(input, {
      rootDir: fixture,
      stableSourceNamespace: "migration-fixture",
    });
    const second = await migrateLegacyDigestOutput(input, {
      rootDir: fixture,
      stableSourceNamespace: "migration-fixture",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.backup).toHaveLength(1);
    expect(first.value.backup[0].path).toBe("legacy-output.json");
    expect(Buffer.from(first.value.backup[0].bytes).equals(input)).toBe(true);
    expect(first.value.resources).toEqual(second.value.resources);
    const asset = first.value.resources.find((resource) => resource.type === "Asset");
    const guide = first.value.resources.find(
      (resource) => resource.type === "Guide" && resource.name === "guide",
    );
    const assetFreeGuide = first.value.resources.find(
      (resource) => resource.type === "Guide" && resource.name === "asset-free-guide",
    );
    const assetFreePage = first.value.resources.find(
      (resource) => resource.type === "WikiPage" && resource.name === "asset-free-page",
    );
    expect(asset?.name).toMatch(/^auto-v1-[a-z2-7]{52}$/u);
    expect(asset?.spec).toMatchObject({
      integrity: `sha256:${digest(bytes)}`,
      size: bytes.byteLength,
      mediaType: "application/octet-stream",
    });
    expect(asset?.labels).toEqual({ kind: "manual" });
    expect(guide?.spec).not.toHaveProperty("assets");
    expect(guide).toMatchObject({
      spec: { content: { value: expect.stringContaining(`asset:${asset?.name}`) } },
    });
    expect(assetFreeGuide?.spec).not.toHaveProperty("assets");
    expect(assetFreeGuide).toMatchObject({
      spec: { content: { value: "No asset references." } },
    });
    expect(assetFreePage?.spec).not.toHaveProperty("assets");
    expect(assetFreePage).toMatchObject({
      spec: { content: { value: "Still no asset references." } },
    });
  });

  test("ingests separate JSON, JSONL, and YAML resources with exact deterministic backup", async () => {
    const bytes = Buffer.from("portable bytes\n");
    await writeFile(join(dir, "manual.bin"), bytes);
    const asset = legacyAsset(bytes, "manual.bin");
    const guide = legacyGuide(`![Manual](asset:${asset.name})`, [asset.name]);
    const page = legacyWikiPage("No assets");
    const files = [
      {
        path: `Asset/${asset.name}.json`,
        bytes: `${JSON.stringify(asset, null, 2)}\n`,
      },
      { path: "Guide/guide.jsonl", bytes: `${JSON.stringify(guide)}\n` },
      { path: "WikiPage/page.yaml", bytes: stringifyYaml(page) },
    ];

    const first = await migrateLegacyDigestOutput(files, {
      rootDir: dir,
      stableSourceNamespace: "migration-fixture",
    });
    const second = await migrateLegacyDigestOutput([...files].reverse(), {
      rootDir: dir,
      stableSourceNamespace: "migration-fixture",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.resources).toEqual(second.value.resources);
    expect(first.value.backup).toEqual(second.value.backup);
    expect(first.value.backup.map((file) => file.path)).toEqual(
      files.map((file) => file.path).sort(),
    );
    for (const backedUp of first.value.backup) {
      const supplied = files.find((file) => file.path === backedUp.path);
      expect(new TextDecoder().decode(backedUp.bytes)).toBe(supplied?.bytes);
    }

    const malformed = await migrateLegacyDigestOutput(
      [...files, { path: "Guide/broken.yaml", bytes: "type: [" }],
      { rootDir: dir, stableSourceNamespace: "migration-fixture" },
    );
    expect(malformed.ok).toBe(false);
    expect(malformed).not.toHaveProperty("value");
  });

  test("treats an absent legacy Asset list as empty and rejects any hidden reference", async () => {
    const bytes = Buffer.from("portable bytes\n");
    await writeFile(join(dir, "manual.bin"), bytes);
    const asset = legacyAsset(bytes, "manual.bin");
    const noList = legacyGuide(`![Manual](asset:${asset.name})`);
    const input = legacyEnvelope([asset, noList]);

    const result = await migrateLegacyDigestOutput(input, {
      rootDir: dir,
      stableSourceNamespace: "migration-fixture",
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });

  test("does not migrate a normalized destination using proof from a Markdoc attribute", async () => {
    const content =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    const result = await migrateLegacyDigestOutput(legacyEnvelope([legacyGuide(content)]), {
      rootDir: dir,
      stableSourceNamespace: "migration-fixture",
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });

  test("fails without partial output for changed bytes, a false digest name, or a partial set", async () => {
    const bytes = Buffer.from("original\n");
    await writeFile(join(dir, "one.bin"), Buffer.from("changed\n"));
    await writeFile(join(dir, "two.bin"), bytes);
    await writeFile(join(dir, "three.bin"), bytes);
    const changedAsset = legacyAsset(bytes, "one.bin");
    const falseNameAsset = legacyAsset(bytes, "two.bin");
    const partialAsset = legacyAsset(bytes, "three.bin");

    for (const input of [
      legacyEnvelope([
        changedAsset,
        legacyGuide(`![One](asset:${changedAsset.name})`, [changedAsset.name]),
      ]),
      legacyEnvelope([
        { ...falseNameAsset, name: "0000000000000000" },
        legacyGuide("No reference", []),
      ]),
      legacyEnvelope([partialAsset, legacyGuide("No reference", [])]),
    ]) {
      const result = await migrateLegacyDigestOutput(input, {
        rootDir: dir,
        stableSourceNamespace: "migration-fixture",
      });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("value");
    }
  });

  test("rejects path aliases, malformed resources, and remote legacy input", async () => {
    const upper = Buffer.from("upper\n");
    const lower = Buffer.from("lower\n");
    await writeFile(join(dir, "A.bin"), upper);
    await writeFile(join(dir, "a.bin"), lower);
    const upperAsset = legacyAsset(upper, "A.bin");
    const lowerAsset = legacyAsset(lower, "a.bin");
    const cases = [
      legacyEnvelope([upperAsset, lowerAsset]),
      '{"resources":[{"type":"Asset"}]}',
      legacyEnvelope([
        {
          ...upperAsset,
          spec: { ...upperAsset.spec, uri: "https://example.com/revision.bin" },
        },
      ]),
    ];

    for (const input of cases) {
      const result = await migrateLegacyDigestOutput(input, {
        rootDir: dir,
        stableSourceNamespace: "migration-fixture",
      });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("value");
    }
  });
});

function legacyEnvelope(resources: unknown[]): string {
  return `${JSON.stringify({ resources }, null, 2)}\n`;
}

function legacyAsset(bytes: Uint8Array, uri: string) {
  const hash = digest(bytes);
  return {
    apiVersion: "v1",
    type: "Asset",
    name: hash.slice(0, 16),
    spec: {
      uri,
      integrity: `sha256-${Buffer.from(hash, "hex").toString("base64")}`,
    },
  };
}

function legacyGuide(content: string, assets?: string[]) {
  return {
    apiVersion: "v1",
    type: "Guide",
    name: "guide",
    spec: {
      title: "Guide",
      slug: "guide",
      content: { format: "topik", value: content },
      ...(assets === undefined ? {} : { assets }),
    },
  };
}

function legacyWikiPage(content: string) {
  return {
    apiVersion: "v1",
    type: "WikiPage",
    name: "page",
    spec: {
      wiki: "docs",
      title: "Page",
      content: { format: "topik", value: content },
    },
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
