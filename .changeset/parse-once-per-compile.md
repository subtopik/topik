---
"@topik/content": patch
"@topik/core": patch
---

Compile large projects about three times faster. A compilation parses each
document once and shares the tree between validation, analysis, Asset and link
rewriting and the compiled-output checks, instead of parsing it up to nine times;
data-limit checks of a shared tree run once. A project of 2,500 documents
compiles in about 18 seconds instead of 54, with identical output.

Analysis no longer writes generated heading IDs into the authoring tree it
reads, so `rewriteTopikNavigationReferences` agrees with `validateTopikContent`
for a heading whose generated ID would exceed the data limits; compilation still
refuses it.
