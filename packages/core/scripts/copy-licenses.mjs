import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const licenses = ["Unicode-3.0.txt"];
const source = new URL("../../../LICENSES/", import.meta.url);
const destination = new URL("../dist/LICENSES/", import.meta.url);

await mkdir(destination, { recursive: true });
for (const license of licenses) {
  await copyFile(
    fileURLToPath(new URL(license, source)),
    fileURLToPath(new URL(license, destination)),
  );
}
