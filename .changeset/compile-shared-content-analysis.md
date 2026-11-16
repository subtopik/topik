---
"@topik/core": patch
---

Standalone `compileWiki`, `compileGuides` and `compileCourse` admit and analyze each page
fewer times per call: link compilation reuses the discovery analysis and Asset compilation
reuses the discovery admission of unchanged page text. Output is unchanged.
