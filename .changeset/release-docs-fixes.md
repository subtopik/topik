---
"@topik/core": patch
"@topik/cli": patch
"@topik/codemod": patch
"@topik/content": patch
---

Documentation fixes:

- The library examples in the `@topik/core` README and the resources guide pass a name generator, so they also compile a wiki that has local images or downloads.
- The CLI README describes the `lint --json` report for a failure that stops lint.
- The preview protocol describes how `topik dev` prints a failure that stops compilation.
- The codemod README lists root-absolute image and file paths among the reasons a page is kept unchanged.
- The content design guide shows how to write a quiz.
