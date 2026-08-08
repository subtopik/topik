import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import { extractTopikAssetOccurrences } from "@topik/content-schema";
import {
  parseAssetManifest,
  parseStrictTopikJson,
  serializeAssetManifest,
  serializeTopikJson,
  validatePortableAssetSnapshot,
} from "@topik/core";
import { guideV2Schema, type GuideV2 } from "@topik/schema";
import { renderTopikMarkdown } from "./core/render";

const root = join(import.meta.dirname, "fixtures", "portable-root");
const descriptorPath = "guide.json";
const contentPath = "content.md";
const binaryPath = "files/manual.bin";
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const validateGuideV2 = ajv.compile(guideV2Schema);

interface OfflineFixtureBytes {
  descriptor: Uint8Array;
  sidecar: Uint8Array;
  content: Uint8Array;
  binary: Uint8Array;
}

function fixtureBytes(): OfflineFixtureBytes {
  return {
    descriptor: readFileSync(join(root, descriptorPath)),
    sidecar: readFileSync(join(root, ".topik", "assets.json")),
    content: readFileSync(join(root, contentPath)),
    binary: readFileSync(join(root, binaryPath)),
  };
}

function validateOfflineFixture(input: OfflineFixtureBytes) {
  let descriptorValue: unknown;
  let content: string;
  try {
    descriptorValue = parseStrictTopikJson(
      new TextDecoder("utf-8", { fatal: true }).decode(input.descriptor),
    );
    content = new TextDecoder("utf-8", { fatal: true }).decode(input.content);
  } catch {
    return { ok: false as const, reason: "invalid descriptor/content encoding" };
  }
  if (!validateGuideV2(descriptorValue)) {
    return { ok: false as const, reason: "Guide/v2 schema mismatch" };
  }
  const descriptor = descriptorValue as GuideV2;
  if (descriptor.spec.content.value !== content) {
    return { ok: false as const, reason: "descriptor content mismatch" };
  }

  const parsed = parseAssetManifest(input.sidecar);
  if (!parsed.ok) return { ok: false as const, reason: "sidecar mismatch" };
  const resource = {
    apiVersion: descriptor.apiVersion,
    type: descriptor.type,
    name: descriptor.name,
    path: descriptorPath,
  } as const;
  const snapshot = validatePortableAssetSnapshot({
    manifest: parsed.value.manifest,
    resource,
    contents: [{ path: contentPath, source: descriptor.spec.content.value }],
    files: [
      {
        path: binaryPath,
        type: "regular",
        mode: "100644",
        bytes: input.binary,
        linkCount: 1,
      },
    ],
  });
  if (!snapshot.ok) return { ok: false as const, reason: "portable snapshot mismatch" };
  return {
    ok: true as const,
    binary: input.binary,
    content: descriptor.spec.content.value,
    descriptor,
    manifestBytes: input.sidecar,
    parsed: parsed.value,
    snapshot: snapshot.value,
  };
}

describe("offline portable resource root", () => {
  test("parses the Guide descriptor, validates its binding/content, and verifies offline bytes", () => {
    const validated = validateOfflineFixture(fixtureBytes());
    expect(validated.ok, validated.ok ? undefined : validated.reason).toBe(true);
    if (!validated.ok) return;

    expect(validated.descriptor).toMatchObject({
      apiVersion: "v2",
      type: "Guide",
      name: "offline-guide",
    });
    expect(validated.snapshot.files[0].digest).toBe(
      "22e3a2780f894d9edb42ff05ed92f60deb399e0a2baf6c1c210a14d3957003c7",
    );
    expect(
      extractTopikAssetOccurrences(validated.content, {
        manifestPaths: [binaryPath],
      }),
    ).toHaveLength(1);

    const html = renderToStaticMarkup(
      <>
        {renderTopikMarkdown(validated.content, {
          components: {
            TopikLink: ({ children, href }) => <a href={String(href)}>{children}</a>,
          },
        })}
      </>,
    );
    expect(html).toContain('<a href="files/manual.bin">Manual</a>');

    const serialized = serializeAssetManifest(validated.parsed.manifest);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(Buffer.from(serialized.value).equals(validated.manifestBytes)).toBe(true);
    expect(parseAssetManifest(serialized.value)).toMatchObject({ ok: true });
  });

  test("rejects descriptor binding and descriptor-content mismatches", () => {
    const input = fixtureBytes();
    const descriptor = parseStrictTopikJson(new TextDecoder().decode(input.descriptor)) as GuideV2;

    const wrongBinding = {
      ...input,
      descriptor: new TextEncoder().encode(
        serializeTopikJson({ ...descriptor, name: "different-guide" }),
      ),
    };
    expect(validateOfflineFixture(wrongBinding)).toMatchObject({
      ok: false,
      reason: "portable snapshot mismatch",
    });

    const wrongContent = {
      ...input,
      descriptor: new TextEncoder().encode(
        serializeTopikJson({
          ...descriptor,
          spec: {
            ...descriptor.spec,
            content: { ...descriptor.spec.content, value: "Different content\n" },
          },
        }),
      ),
    };
    expect(validateOfflineFixture(wrongContent)).toMatchObject({
      ok: false,
      reason: "descriptor content mismatch",
    });
  });
});
