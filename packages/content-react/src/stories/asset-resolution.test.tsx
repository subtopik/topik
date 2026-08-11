import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TopikContent } from "../theme/TopikContent";
import { FigureAndBadge, TableAndImage } from "./Components.stories";
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
