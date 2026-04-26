import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { extractAssets } from "./assets";

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const PNG_NAME = createHash("sha256").update(PNG_BYTES).digest("hex").slice(0, 16);

describe("extractAssets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "topik-assets-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writePng(relPath: string) {
    const full = join(dir, relPath);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, PNG_BYTES);
  }

  test("emits an Asset for a relative image reference", async () => {
    await writePng("images/hero.png");
    const filePath = join(dir, "page.md");
    await writeFile(filePath, "# Page\n\n![a hero](./images/hero.png)\n");

    const { content, assets } = await extractAssets("# Page\n\n![a hero](./images/hero.png)\n", {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      apiVersion: "v1",
      type: "Asset",
      name: PNG_NAME,
      spec: { uri: "images/hero.png", mediaType: "image/png" },
    });
    expect(assets[0].name).toMatch(/^[a-f0-9]{16}$/);
    expect(assets[0].spec.integrity).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    expect(content).toBe(`# Page\n\n![a hero](asset:${PNG_NAME})\n`);
  });

  test("resolves root-absolute refs against the base directory", async () => {
    await writePng("images/hero.png");
    const filePath = join(dir, "nested", "page.md");
    await mkdir(join(dir, "nested"), { recursive: true });

    const { content, assets } = await extractAssets("![hero](/images/hero.png)", {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(1);
    expect(assets[0].spec.uri).toBe("images/hero.png");
    expect(content).toBe(`![hero](asset:${PNG_NAME})`);
  });

  test("resolves relative refs against the file's directory", async () => {
    await writePng("nested/diagram.png");
    const filePath = join(dir, "nested", "page.md");

    const { assets } = await extractAssets("![d](./diagram.png)", { baseDir: dir, filePath });

    expect(assets[0].spec.uri).toBe("nested/diagram.png");
    expect(assets[0].name).toBe(PNG_NAME);
  });

  test("dedupes multiple references to the same image", async () => {
    await writePng("images/hero.png");
    const filePath = join(dir, "page.md");

    const { content, assets } = await extractAssets(
      "![a](./images/hero.png)\n\n![b](./images/hero.png)\n",
      { baseDir: dir, filePath },
    );

    expect(assets).toHaveLength(1);
    expect(content).toBe(`![a](asset:${PNG_NAME})\n\n![b](asset:${PNG_NAME})\n`);
  });

  test("leaves remote URLs unchanged", async () => {
    const filePath = join(dir, "page.md");
    const source = [
      "![a](https://example.com/x.png)",
      "![b](http://example.com/x.png)",
      "![c](//cdn.example.com/x.png)",
      "![d](data:image/png;base64,iVBORw0K)",
    ].join("\n\n");

    const { content, assets } = await extractAssets(source, {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(0);
    expect(content).toBe(source);
  });

  test("rejects references that escape the base directory", async () => {
    const filePath = join(dir, "page.md");
    await expect(extractAssets("![x](../outside.png)", { baseDir: dir, filePath })).rejects.toThrow(
      /outside the compilation directory/,
    );
  });

  test("errors when the referenced file does not exist", async () => {
    const filePath = join(dir, "page.md");
    await expect(extractAssets("![x](./missing.png)", { baseDir: dir, filePath })).rejects.toThrow(
      /not found/,
    );
  });

  test("handles reference-style definitions", async () => {
    await writePng("images/hero.png");
    const filePath = join(dir, "page.md");
    const source = "![hero][h]\n\n[h]: ./images/hero.png\n";

    const { content, assets } = await extractAssets(source, {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(1);
    expect(content).toContain(`[h]: asset:${PNG_NAME}`);
  });

  test("does not rewrite image syntax inside fenced code blocks", async () => {
    const filePath = join(dir, "page.md");
    const source = "```md\n![x](./images/missing.png)\n```\n";

    const { content, assets } = await extractAssets(source, {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(0);
    expect(content).toBe(source);
  });

  test("assigns media type from extension", async () => {
    await writePng("diagram.svg");
    const filePath = join(dir, "page.md");

    const { assets } = await extractAssets("![d](./diagram.svg)", {
      baseDir: dir,
      filePath,
    });

    expect(assets[0].spec.mediaType).toBe("image/svg+xml");
  });

  test("preserves the image title when rewriting the URL", async () => {
    await writePng("hero.png");
    const filePath = join(dir, "page.md");
    const source = '![alt](./hero.png "A great hero")\n';

    const { content } = await extractAssets(source, { baseDir: dir, filePath });

    expect(content).toBe(`![alt](asset:${PNG_NAME} "A great hero")\n`);
  });

  test("rewrites multiple distinct images independently", async () => {
    await writePng("a.png");
    await writeFile(
      join(dir, "b.png"),
      Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000020000000208060000007234e9930000000c49444154789c63600200000000050001b8d2a85f0000000049454e44ae426082",
        "hex",
      ),
    );
    const filePath = join(dir, "page.md");
    const source = "![a](./a.png) text ![b](./b.png)\n";

    const { content, assets } = await extractAssets(source, { baseDir: dir, filePath });

    expect(assets).toHaveLength(2);
    const aName = assets.find((x) => x.spec.uri === "a.png")!.name;
    const bName = assets.find((x) => x.spec.uri === "b.png")!.name;
    expect(content).toBe(`![a](asset:${aName}) text ![b](asset:${bName})\n`);
  });

  test("extracts links to local files with known asset extensions", async () => {
    await writePng("manual.pdf");
    const filePath = join(dir, "page.md");
    const source = "[download the manual](./manual.pdf)\n";

    const { content, assets } = await extractAssets(source, { baseDir: dir, filePath });

    expect(assets).toHaveLength(1);
    expect(assets[0].spec.uri).toBe("manual.pdf");
    expect(assets[0].spec.mediaType).toBe("application/pdf");
    expect(content).toBe(`[download the manual](asset:${assets[0].name})\n`);
  });

  test("does not extract links to other markdown pages", async () => {
    await writeFile(join(dir, "other.md"), "# Other\n");
    const filePath = join(dir, "page.md");
    const source = "[see also](./other.md)\n";

    const { content, assets } = await extractAssets(source, { baseDir: dir, filePath });

    expect(assets).toHaveLength(0);
    expect(content).toBe(source);
  });

  test("does not extract links without a known asset extension", async () => {
    const filePath = join(dir, "page.md");
    const source = "[learn more](./somewhere)\n";

    const { content, assets } = await extractAssets(source, { baseDir: dir, filePath });

    expect(assets).toHaveLength(0);
    expect(content).toBe(source);
  });

  test("rewrites URL-encoded paths", async () => {
    await writePng("my image.png");
    const filePath = join(dir, "page.md");
    const source = "![x](./my%20image.png)\n";

    const { content, assets } = await extractAssets(source, { baseDir: dir, filePath });

    expect(assets).toHaveLength(1);
    expect(assets[0].spec.uri).toBe("my image.png");
    expect(content).toBe(`![x](asset:${PNG_NAME})\n`);
  });

  test("dedupes references with different paths but identical bytes", async () => {
    await writePng("a/logo.png");
    await writePng("b/logo.png");
    const filePath = join(dir, "page.md");

    const { assets } = await extractAssets("![a](./a/logo.png)\n\n![b](./b/logo.png)\n", {
      baseDir: dir,
      filePath,
    });

    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe(PNG_NAME);
  });

  test("omits media type when extension is unknown", async () => {
    await writePng("blob.xyz");
    const filePath = join(dir, "page.md");

    const { assets } = await extractAssets("![b](./blob.xyz)", {
      baseDir: dir,
      filePath,
    });

    expect(assets[0].spec).not.toHaveProperty("mediaType");
  });
});
