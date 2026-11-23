---
"@topik/remark-tags": patch
"@topik/content": patch
"@topik/schema": patch
"@topik/core": patch
"@topik/content-react": patch
"@topik/cli": patch
"@topik/codemod": patch
---

Breaking: every public package requires Node.js 22.22 or later (`>=22.22.0`), up from 22.12, because chokidar 6, which the watcher now uses, requires it.
