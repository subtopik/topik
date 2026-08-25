import { readdirSync } from "node:fs";

const npmRootMetadata = /^(?:readme|copying|licen[cs]e)(?:\..*[^~$])?$/iu;

export function listNpmRootMetadata(packageRoot) {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && npmRootMetadata.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
}
