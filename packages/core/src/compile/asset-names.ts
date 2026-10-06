import { isAbsolute, relative, resolve, sep } from "node:path";
import { generateAutomaticAssetName, validateProjectNamespace } from "../assets/asset";
import { topikAssetDiagnostic } from "../assets/diagnostics";
import { AssetCompilationError, type AssetNameGenerator } from "./assets";

export interface ProjectAssetNameOptions {
  /** Directory containing the manifest, or an explicitly chosen root for standalone use. */
  projectRoot: string;
  projectNamespace: string;
}

/** Create the project's naming policy without reading or requiring a manifest. */
export function createProjectAssetNameGenerator(
  options: ProjectAssetNameOptions,
): AssetNameGenerator {
  const root = resolve(options.projectRoot);
  const namespace = validateProjectNamespace(options.projectNamespace);
  if (!namespace.ok) {
    throw new AssetCompilationError("Project namespace is invalid", namespace.diagnostics);
  }
  return ({ resolvedAssetPath }) => {
    const path = relative(root, resolvedAssetPath);
    if (
      !isAbsolute(resolvedAssetPath) ||
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith(`..${sep}`)
    ) {
      throw new AssetCompilationError("Asset path is outside the project root", [
        topikAssetDiagnostic("TOPIK_ASSET_PATH_INVALID", "Asset path is outside the project root"),
      ]);
    }
    const generated = generateAutomaticAssetName({
      projectNamespace: namespace.value,
      manifestRelativePath: path.split(sep).join("/"),
    });
    if (!generated.ok) {
      throw new AssetCompilationError(
        "Automatic Asset name could not be generated",
        generated.diagnostics,
      );
    }
    return generated.value;
  };
}
