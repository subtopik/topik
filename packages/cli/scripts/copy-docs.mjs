// Copy the repository's docs into the package, so the published CLI carries the guides for
// its own version at node_modules/@topik/cli/docs. The copy is build output and is not tracked.
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../docs/", import.meta.url));
const destination = fileURLToPath(new URL("../docs/", import.meta.url));

// Start empty, so a page deleted from the repository is not shipped.
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
