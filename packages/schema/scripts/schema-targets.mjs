import { readdir } from "node:fs/promises";
import { join } from "node:path";

const resourceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const versionFilePattern = /^(v[1-9][0-9]*)\.(json|ts)$/u;

export async function discoverSchemaTargets(packageDirectory) {
  const sourceDirectory = join(packageDirectory, "src");
  const resources = (await readdir(sourceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  /** @type {Array<{ resource: string, version: string, schema: string, types: string }>} */
  const targets = [];

  for (const resource of resources) {
    if (!resourceNamePattern.test(resource.name)) {
      throw new Error(`Invalid schema resource directory: src/${resource.name}`);
    }

    const files = await readdir(join(sourceDirectory, resource.name), { withFileTypes: true });
    /** @type {Set<string>} */
    const schemas = new Set();
    /** @type {Set<string>} */
    const generatedTypes = new Set();

    for (const file of files) {
      if (file.name.endsWith(".test.ts")) continue;
      if (!file.isFile() || (!file.name.endsWith(".json") && !file.name.endsWith(".ts"))) {
        continue;
      }
      const match = versionFilePattern.exec(file.name);
      if (match === null) {
        throw new Error(`Invalid versioned schema filename: src/${resource.name}/${file.name}`);
      }
      const [, version, extension] = match;
      (extension === "json" ? schemas : generatedTypes).add(version);
    }

    for (const version of generatedTypes) {
      if (!schemas.has(version)) {
        throw new Error(
          `Generated types have no matching schema: src/${resource.name}/${version}.ts`,
        );
      }
    }

    for (const version of [...schemas].sort(compareVersions)) {
      targets.push({
        resource: resource.name,
        version,
        schema: `src/${resource.name}/${version}.json`,
        types: `src/${resource.name}/${version}.ts`,
      });
    }
  }

  return targets;
}

function compareVersions(left, right) {
  const leftNumber = left.slice(1);
  const rightNumber = right.slice(1);
  return leftNumber.length - rightNumber.length || leftNumber.localeCompare(rightNumber);
}
