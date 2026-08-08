import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import {
  parseAssetManifest,
  serializeAssetManifest,
  validatePortableAssetSnapshot,
} from "@topik/core";
import { renderTopikMarkdown } from "./core/render";

const root = join(import.meta.dirname, "fixtures", "portable-root");

describe("offline portable resource root", () => {
  test("parses, validates, extracts, renders, serializes, reparses, and verifies exact bytes", () => {
    const sidecar = readFileSync(join(root, ".topik", "assets.json"));
    const content = readFileSync(join(root, "content.md"), "utf8");
    const binary = readFileSync(join(root, "files", "manual.bin"));
    const parsed = parseAssetManifest(sidecar);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const validation = validatePortableAssetSnapshot({
      manifest: parsed.value.manifest,
      resource: parsed.value.manifest.resource,
      contents: [{ path: "content.md", source: content }],
      files: [
        {
          path: "files/manual.bin",
          type: "regular",
          mode: "100644",
          bytes: binary,
          linkCount: 1,
        },
      ],
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.value.files[0].digest).toBe(
      "22e3a2780f894d9edb42ff05ed92f60deb399e0a2baf6c1c210a14d3957003c7",
    );
    expect(
      extractTopikAssetOccurrences(content, { manifestPaths: ["files/manual.bin"] }),
    ).toHaveLength(1);

    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(content, {
          components: {
            TopikLink: ({ children, href }) => <a href={String(href)}>{children}</a>,
          },
        })}
      </>,
    );
    expect(html).toContain('<a href="files/manual.bin">Manual</a>');

    const serialized = serializeAssetManifest(parsed.value.manifest);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(Buffer.from(serialized.value).equals(sidecar)).toBe(true);
    expect(parseAssetManifest(serialized.value)).toMatchObject({ ok: true });
  });
});
