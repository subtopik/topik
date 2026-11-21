import { join, posix, resolve } from "node:path";
import { parseDocument, isAlias, isNode, isMap, isSeq, isScalar } from "yaml";
import {
  createPortableReadSession,
  portableReadFailureReason,
  readPortableAssetFileInSession,
  type PortableReadSession,
} from "../assets/files";
import { parseStrictTopikJson } from "../assets/json";
import { isConfigurationPath, TOPIK_MANIFEST_LIMITS } from "../config/manifest";
import { readRegularFileWithinRoot } from "./files";
import { PublicCompileError } from "./public-errors";

/**
 * Load the first conventional config file that exists, such as `wiki.yaml` then `wiki.json`.
 * It is parsed like an explicitly selected configuration: the same size limit, byte order
 * mark handling, strict JSON and safe YAML.
 */
export async function readOptionalConfigFileWithPath(
  dir: string,
  candidates: readonly string[],
): Promise<LoadedConfig | undefined> {
  for (const name of candidates) {
    const filePath = join(dir, name);
    let raw: string;

    try {
      raw = await readRegularFileWithinRoot(filePath, dir, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      if (error instanceof PublicCompileError && error.id === "file-safe-read-unsupported") {
        throw error;
      }
      throw new PublicCompileError("config-read-failed", name, { cause: error });
    }
    if (Buffer.byteLength(raw, "utf8") > TOPIK_MANIFEST_LIMITS.maxBytes)
      throw new PublicCompileError("config-read-failed", name);

    try {
      return { path: name, value: parseConfigurationText(name, raw) };
    } catch {
      throw new PublicCompileError("config-parse-failed", name);
    }
  }
  return undefined;
}

function parseConfigurationText(path: string, raw: string): unknown {
  return path.endsWith(".json")
    ? parseStrictTopikJson(raw.replace(/^\uFEFF/u, ""), 32)
    : parseSafeConfigurationYaml(raw);
}

/** Load exactly one portable config, without conventional-name fallback. */
export async function readExactConfigFile(
  dir: string,
  path: string,
  session?: PortableReadSession,
): Promise<LoadedConfig> {
  if (!isConfigurationPath(path)) throw new PublicCompileError("config-invalid", path);
  const raw = await readConfigurationText(dir, path, session);
  try {
    return { path: posix.basename(path), value: parseConfigurationText(path, raw) };
  } catch {
    throw new PublicCompileError("config-parse-failed", path);
  }
}

export interface LoadedConfig {
  path: string;
  value: unknown;
}

export function configurationDirectory(dir: string, configFile?: string): string {
  if (configFile === undefined) return resolve(dir);
  if (!isConfigurationPath(configFile)) throw new PublicCompileError("config-invalid", configFile);
  return resolve(dir, posix.dirname(configFile));
}

export async function readConfigurationText(
  dir: string,
  path: string,
  session: PortableReadSession = createPortableReadSession(),
): Promise<string> {
  const result = await readPortableAssetFileInSession(session, {
    root: resolve(dir),
    path,
    maxBytes: TOPIK_MANIFEST_LIMITS.maxBytes,
  });
  if (!result.ok || result.value.bytes === undefined) {
    const missing = result.diagnostics.some(
      (diagnostic) => diagnostic.id === "TOPIK_ASSET_FILE_MISSING",
    );
    // Reader diagnostics are sanitized, but stay a non-enumerable debugging aid; the public
    // error carries only a fixed reason category.
    throw new PublicCompileError(missing ? "config-not-found" : "config-read-failed", path, {
      cause: new AggregateError(result.diagnostics, "Portable configuration read failed"),
      reason: missing ? undefined : portableReadFailureReason(result.diagnostics),
    });
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.value.bytes);
  } catch {
    throw new PublicCompileError("config-parse-failed", path);
  }
}

/** YAML core data only: no aliases, custom tags, duplicate keys, or unbounded nesting. */
export function parseSafeConfigurationYaml(raw: string): unknown {
  if (Buffer.byteLength(raw) > TOPIK_MANIFEST_LIMITS.maxBytes)
    throw new Error("Configuration is too large");
  const document = parseDocument(raw, { schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) throw new Error("Invalid YAML");
  const pending = [{ node: document.contents, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) break;
    const { node, depth } = entry;
    if (depth > TOPIK_MANIFEST_LIMITS.maxDepth || isAlias(node))
      throw new Error("Unsupported YAML structure");
    if (
      isNode(node) &&
      node.tag &&
      ![
        "tag:yaml.org,2002:map",
        "tag:yaml.org,2002:seq",
        "tag:yaml.org,2002:str",
        "tag:yaml.org,2002:int",
        "tag:yaml.org,2002:bool",
        "tag:yaml.org,2002:null",
        "tag:yaml.org,2002:float",
      ].includes(node.tag)
    ) {
      throw new Error("Unsupported YAML tag");
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string")
          throw new Error("Invalid mapping key");
        pending.push({ node: pair.value as typeof document.contents, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const child of node.items)
        pending.push({ node: child as typeof document.contents, depth: depth + 1 });
    }
  }
  return document.toJS({ maxAliasCount: 0 });
}
