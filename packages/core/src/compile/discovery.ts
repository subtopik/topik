import { discoverGuides, type CompileResourceDiscovery } from "./guide";
import { discoverWiki } from "./wiki";
import { discoverCourse } from "./course";

export interface DiscoverResourceOptions {
  dir: string;
  /** Exact config path relative to dir; content is relative to its directory. */
  configFile?: string;
}
export type SourceResourceDiscovery = CompileResourceDiscovery;

/** Read authoring metadata and paths before combining a caller-owned source inventory. */
export async function discoverGuideResources(
  options: DiscoverResourceOptions,
): Promise<SourceResourceDiscovery> {
  return discoverGuides(options);
}

/** Read authoring metadata and paths before combining a caller-owned source inventory. */
export async function discoverWikiResources(
  options: DiscoverResourceOptions,
): Promise<SourceResourceDiscovery> {
  return discoverWiki(options);
}

/** Read Course membership, metadata and paths without compiling links or Assets. */
export async function discoverCourseResources(
  options: DiscoverResourceOptions,
): Promise<SourceResourceDiscovery> {
  return discoverCourse(options);
}
