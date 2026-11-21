---
"@topik/core": patch
---

Git evidence checks turn off the repository's `core.fsmonitor` setting. A `.git/config` that names an fsmonitor command no longer runs it while `compile`, `lint`, `format` or `dev` reads the index.
