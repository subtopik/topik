---
"@topik/core": patch
---

Preserve the target, query, and fragment of newly authored Markdown links with
trailing path separators when their source files move. Source planning now uses
the same path normalization as compilation while retaining unchanged authored
link spelling.

Keep existing non-Markdown file and directory links distinct from page aliases
during inspection, source comparison and source repairs. Moving a same-stem page
no longer retargets an unrelated directory link; cards continue to track their
document targets.
