export const diagramAssetName = "auto-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const heroAssetName = "auto-v1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbq";
export const darkHeroAssetName = "auto-v1-ccccccccccccccccccccccccccccccccccccccccccccccccccca";

const assets: Record<string, string> = {
  [diagramAssetName]: "/storybook-assets/diagram.svg",
  [heroAssetName]: "/storybook-assets/hero-light.svg",
  [darkHeroAssetName]: "/storybook-assets/hero-dark.svg",
};

export function resolveStoryAsset(name: string): string | undefined {
  return assets[name];
}
