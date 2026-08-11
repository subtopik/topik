import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const ASTRO_CLI = join(import.meta.dirname, "../node_modules/.bin/astro");
const WORKSPACE_NODE_MODULES = join(import.meta.dirname, "../node_modules");
const TOPIK_ASTRO_SOURCE = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const PDF_BYTES = Buffer.from("%PDF-1.7\nmanual\n");

describe("Astro production Asset delivery", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("a real static build materializes deduplicated Guide and Wiki compiler payloads", async () => {
    const root = await createFixture();

    await buildFixture(root);
    roots.push(root);

    const digestDir = join(root, "dist/assets/sha256");
    const digests = await readdir(digestDir);
    expect(digests).toHaveLength(2);
    const outputBytes = await Promise.all(
      digests.map((digest) => readFile(join(digestDir, digest))),
    );
    expect(outputBytes.some((bytes) => bytes.equals(PNG_BYTES))).toBe(true);
    expect(outputBytes.some((bytes) => bytes.equals(PDF_BYTES))).toBe(true);

    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html.match(/href="\/assets\/sha256\/[0-9a-f]{64}"/gu)).toHaveLength(4);
    expect(html).not.toContain("hero.png");
    expect(html).not.toContain("manual.pdf");
  }, 15_000);

  test("a replacement build removes payloads that are no longer compiler-referenced", async () => {
    const root = await createFixture();
    await buildFixture(root);
    roots.push(root);
    expect(await pathExists(join(root, "dist/assets/sha256"))).toBe(true);

    await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\nNo Assets.\n");
    await writeFile(join(root, "content/wiki/intro.md"), "# Wiki\n\nNo Assets.\n");
    await buildFixture(root);

    expect(await pathExists(join(root, "dist/assets/sha256"))).toBe(false);
  }, 15_000);

  test("a failed replacement build leaves no prior or unsafe delivery snapshot", async () => {
    const root = await createFixture();
    await buildFixture(root);
    roots.push(root);
    expect(await pathExists(join(root, "dist/assets/sha256"))).toBe(true);
    await writeFile(join(root, "content/guides/active.svg"), '<svg onload="alert(1)" />');
    await writeFile(join(root, "content/guides/intro.md"), "# Guide\n\n![Active](active.svg)\n");

    await expect(buildFixture(root)).rejects.toBeDefined();

    expect(await pathExists(join(root, "dist/assets/sha256"))).toBe(false);
    expect(await pathExists(join(root, "dist/active.svg"))).toBe(false);
  }, 15_000);

  test("a real server build delivers the compiler snapshot through GET and HEAD", async () => {
    const root = await createFixture({ server: true });
    await buildFixture(root);

    const serverModule = (await import(
      `${pathToFileURL(join(root, "dist/server/entry.mjs")).href}?test=${Date.now()}`
    )) as { fetch: (request: Request) => Promise<Response> };
    const page = await serverModule.fetch(new Request("http://example.test/"));
    roots.push(root);
    expect(await readdir(join(root, "dist/client/assets/sha256"))).toHaveLength(2);
    expect(page.status).toBe(200);
    const html = await page.text();
    const urls = [...html.matchAll(/href="(\/assets\/sha256\/[0-9a-f]{64})"/gu)].map(
      (match) => match[1],
    );
    expect(urls).toHaveLength(4);

    for (const url of new Set(urls)) {
      const get = await serverModule.fetch(new Request(`http://example.test${url}`));
      const bytes = Buffer.from(await get.arrayBuffer());
      const expectedMediaType = bytes.equals(PNG_BYTES) ? "image/png" : "application/pdf";
      expect(bytes.equals(PNG_BYTES) || bytes.equals(PDF_BYTES)).toBe(true);
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe(expectedMediaType);
      expect(get.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(get.headers.get("x-content-type-options")).toBe("nosniff");

      const head = await serverModule.fetch(
        new Request(`http://example.test${url}`, { method: "HEAD" }),
      );
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe(expectedMediaType);
      expect(head.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    }

    await writeFile(
      join(root, "content/guides/hero.png"),
      Buffer.concat([PNG_BYTES, Buffer.from([0])]),
    );
    const immutable = await serverModule.fetch(new Request(`http://example.test${urls[0]}`));
    expect(Buffer.from(await immutable.arrayBuffer())).toEqual(PNG_BYTES);

    for (const rawPath of [
      "/hero.png",
      "/manual.pdf",
      "/unreferenced.png",
      "/spoofed.png",
      "/active.svg",
      "/pointer.png",
      "/filtered.png",
      "/executable.png",
      "/special.png",
      "/images/linked.png",
    ]) {
      const response = await serverModule.fetch(new Request(`http://example.test${rawPath}`));
      expect(response.status).toBe(404);
    }
  }, 15_000);
});

async function createFixture(options: { server?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "topik-astro-production-"));
  await symlink(WORKSPACE_NODE_MODULES, join(root, "node_modules"), "dir");
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "content/guides"), { recursive: true });
  await mkdir(join(root, "content/wiki"), { recursive: true });
  await writeFile(join(root, "content/guides/collection.yaml"), "id: guides\ntitle: Guides\n");
  await writeFile(join(root, "content/guides/hero.png"), PNG_BYTES);
  await writeFile(join(root, "content/guides/manual.pdf"), PDF_BYTES);
  await writeFile(join(root, "content/guides/unreferenced.png"), PNG_BYTES);
  await writeFile(join(root, "content/guides/spoofed.png"), "not image bytes");
  await writeFile(join(root, "content/guides/active.svg"), '<svg onload="alert(1)" />');
  await writeFile(
    join(root, "content/guides/pointer.png"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 1\n`,
  );
  await writeFile(join(root, "content/guides/.gitattributes"), "filtered.png filter=custom\n");
  await writeFile(join(root, "content/guides/filtered.png"), PNG_BYTES);
  await writeFile(join(root, "content/guides/executable.png"), PNG_BYTES);
  await chmod(join(root, "content/guides/executable.png"), 0o755);
  await execFileAsync("mkfifo", [join(root, "content/guides/special.png")]);
  await mkdir(join(root, "content/guides/shared"));
  await writeFile(join(root, "content/guides/shared/linked.png"), PNG_BYTES);
  await symlink("shared", join(root, "content/guides/images"), "dir");
  await writeFile(
    join(root, "content/guides/intro.md"),
    "# Guide\n\n![Guide image](hero.png)\n\n[Guide manual](manual.pdf)\n",
  );
  await writeFile(
    join(root, "content/wiki/wiki.yaml"),
    "id: docs\ntitle: Docs\nnavigation:\n  - intro\n",
  );
  await writeFile(join(root, "content/wiki/hero.png"), PNG_BYTES);
  await writeFile(join(root, "content/wiki/manual.pdf"), PDF_BYTES);
  await writeFile(
    join(root, "content/wiki/intro.md"),
    "# Wiki\n\n![Wiki image](hero.png)\n\n[Wiki manual](manual.pdf)\n",
  );
  await writeFile(
    join(root, "topik-loaders.mjs"),
    `import { topikGuidesLoader, topikWikiLoader } from ${JSON.stringify(TOPIK_ASTRO_SOURCE)};\nexport const guidesLoader = topikGuidesLoader({ dir: new URL("./content/guides", import.meta.url).pathname, sourceNamespace: "production-guides" });\nexport const wikiLoader = topikWikiLoader({ dir: new URL("./content/wiki", import.meta.url).pathname, sourceNamespace: "production-wiki" });\n`,
  );
  await writeFile(
    join(root, "src/content.config.mjs"),
    `import { defineCollection } from "astro:content";\nimport { guidesLoader, wikiLoader } from "../topik-loaders.mjs";\nexport const collections = { guides: defineCollection({ loader: guidesLoader }), wiki: defineCollection({ loader: wikiLoader }) };\n`,
  );
  await writeFile(
    join(root, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";\nimport { topik } from ${JSON.stringify(TOPIK_ASTRO_SOURCE)};\nimport { guidesLoader, wikiLoader } from "./topik-loaders.mjs";\n${options.server === true ? 'import testAdapter from "./test-adapter.mjs";\n' : ""}export default defineConfig({ ${options.server === true ? 'output: "server", adapter: testAdapter(), ' : ""}integrations: [topik({ loaders: [guidesLoader, wikiLoader] })] });\n`,
  );
  if (options.server === true) {
    await writeFile(
      join(root, "test-adapter.mjs"),
      `export default function testAdapter() { return { name: "topik-test-adapter", hooks: { "astro:config:done": ({ setAdapter }) => setAdapter({ name: "topik-test-adapter", serverEntrypoint: new URL("./test-server-entry.mjs", import.meta.url), exports: ["fetch"], supportedAstroFeatures: { staticOutput: "stable", hybridOutput: "stable", serverOutput: "stable", i18nDomains: "stable", envGetSecret: "stable", sharpImageService: "stable" } }) } }; }\n`,
    );
    await writeFile(
      join(root, "test-server-entry.mjs"),
      `import { App } from "astro/app";\nexport function createExports(manifest) { const app = new App(manifest); return { fetch(request) { return app.render(request); } }; }\n`,
    );
  }
  await writeFile(
    join(root, "src/pages/index.astro"),
    `---\nimport { getCollection } from "astro:content";\nimport { guidesLoader, wikiLoader } from "../../topik-loaders.mjs";\nconst entries = [...await getCollection("guides"), ...await getCollection("wiki")];\nconst urls = entries.flatMap((entry) => [...entry.body.matchAll(/asset:(auto-v1-[a-z2-7]{51}[aq])/g)].map((match) => (entry.collection === "guides" ? guidesLoader : wikiLoader).resolveAsset(match[1])));\n---\n{entries.map((entry) => <pre>{entry.body}</pre>)}\n{urls.map((url) => <a href={url}>{url}</a>)}\n`,
  );
  return root;
}

async function buildFixture(root: string): Promise<void> {
  try {
    await execFileAsync(ASTRO_CLI, ["build", "--force"], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (error) {
    const output = error as Error & { stderr?: string; stdout?: string };
    throw new Error(
      `${output.message}\nroot=${root}\n${output.stdout ?? ""}\n${output.stderr ?? ""}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
