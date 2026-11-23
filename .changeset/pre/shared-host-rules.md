---
"@topik/core": patch
"@topik/cli": patch
---

Hosts share core's serving and watching rules. `isTopikDownloadOnlyMediaType` tells whether an Asset must be served with `Content-Disposition: attachment`, and `isTopikWatchIgnoredName` tells whether a watcher skips a file or directory name; `topik dev` and the Astro integration use them instead of their own copies.
