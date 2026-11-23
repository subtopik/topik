---
"@topik/core": patch
"@topik/cli": patch
---

`topik lint` and `lint()` report every problem in one run instead of stopping at the first kind of error.

- Errors and warnings in every page are reported together, with broken links in other pages and images or downloads that cannot be compiled. An image or download names the pages that use it, such as `b.md: diagram.png: An image or download could not be compiled (TOPIK_ASSET_FILE_MISSING).`
- Lint reports only what it can judge now. Links to a page whose content has errors are not reported as missing, and its sections are checked once its content is valid. A source whose configuration, frontmatter or page list cannot be read is reported as one error while the other sources are still checked; links and images are then not checked.
- `topik lint --json` lists these failures as error diagnostics, one for each page that uses a failed image or download, and counts them in `errors`.
- `topik compile`, `compile()` and the watcher are unchanged.

Breaking: `lint()` resolves with a new `failures` list where it used to throw, for a source that cannot be read, a check across sources such as an undeclared author, or an image or download. Only a manifest that cannot be loaded still throws. `LintResult` gains `failures`, and `LintFailure` is exported.
