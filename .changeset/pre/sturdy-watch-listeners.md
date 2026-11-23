---
"@topik/core": patch
---

Keep watching projects located below a directory named `.git`, `.topik` or a Topik compilation directory, isolate throwing watcher listeners so they no longer flip a published generation to an error or cause unhandled rejections (their errors are reported to `error` listeners), and release the filesystem watcher as soon as it fails.
