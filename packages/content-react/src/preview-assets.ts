// A light entry for hosts that create the adapter before the renderer loads: it imports neither
// the Markdown compiler nor the renderer. The root entry re-exports the same module instance.
export {
  createPreviewAssetAdapter,
  type PreviewAssetAdapter,
  type PreviewAssetInventory,
} from "./core/preview-assets";
