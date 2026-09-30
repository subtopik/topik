import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TopikContent } from "../theme/TopikContent";
import { FigureAndBadge, TableAndImage } from "./Components.stories";
import * as componentStories from "./Components.stories";
import { ComponentOverride } from "./TopikContent.stories";
import { validateTopikContent } from "@topik/content";
import topikContentMeta, { AssetResolution } from "./TopikContent.stories";

const generatedAssetNamePattern = /^auto-v1-[a-z2-7]{51}[aq]$/u;

interface AssetStoryArgs {
  content: string;
  resolveAsset: (name: string) => string;
}

function getStoryArgs(story: unknown): AssetStoryArgs {
  return (story as { args: AssetStoryArgs }).args;
}

const assetStories = [
  ["learning page", topikContentMeta.args],
  ["asset resolution", getStoryArgs(AssetResolution)],
  ["table and image", getStoryArgs(TableAndImage)],
  ["figure and badge", getStoryArgs(FigureAndBadge)],
] as const;

describe("compiled Asset stories", () => {
  it.each([
    ...Object.entries(componentStories).filter(([name]) => name !== "default"),
    ["ComponentOverride", ComponentOverride],
  ])("uses supported content in the %s example", (_name, story) => {
    const args = getStoryArgs(story);
    expect(
      validateTopikContent(args.content, { allowCompiledAssetReferences: true }),
    ).toMatchObject({ valid: true, errors: [] });
    expect(() => renderToStaticMarkup(<TopikContent {...args} />)).not.toThrow();
  });

  it.each(assetStories)("resolves every generated name in the %s story", (_label, args) => {
    const referencedNames = [...args.content.matchAll(/\basset:([^\s)"']+)/gu)].map(
      ([, name]) => name,
    );
    expect(referencedNames).not.toHaveLength(0);
    expect(referencedNames.every((name) => generatedAssetNamePattern.test(name))).toBe(true);

    const resolveAsset = vi.fn(args.resolveAsset);
    renderToStaticMarkup(<TopikContent content={args.content} resolveAsset={resolveAsset} />);

    expect(resolveAsset.mock.calls.map(([name]) => name)).toEqual(referencedNames);
  });
});
