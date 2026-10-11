---
"@topik/content": minor
"@topik/core": minor
---

Add `ref://course-page/<name>` to the portable document reference contract. Course
pages can be targets of declared Markdown links, cards, and explicit references
from Guides, Wiki pages, or other Course pages. The compiler validates known
fragments and supports CoursePage entries in application-supplied target catalogues.

Course navigation resolves portable identities independently of publishing slugs
while retaining support for existing source paths and routes. Source updates keep
authored link spelling when its meaning is unchanged and repair incoming links
when a target moves. Refresh saved source projects before planning writes: the
writer now uses reference descriptor `source-links-v4` and provenance version `6`.

`discoverCourseResources` exposes authoring metadata and paths for consumers that
combine declared resource inventories before link and Asset compilation.
