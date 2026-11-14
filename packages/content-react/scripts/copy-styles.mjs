// Copies the public stylesheets next to the packed entries. Uses Node APIs so
// the build works the same in POSIX and Windows shells.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../", import.meta.url);

for (const entry of ["theme", "rich"]) {
  const source = fileURLToPath(new URL(`src/${entry}/styles.css`, packageRoot));
  const target = fileURLToPath(new URL(`dist/${entry}/styles.css`, packageRoot));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
