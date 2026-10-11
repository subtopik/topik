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
writer now uses reference descriptor `source-links-v5` and provenance version `7`.

Resolve folder links to a unique declared index or README landing page and emit
its ordinary portable reference. Report missing or ambiguous landings through the
link validation policy; never generate directory listings or undeclared pages.
Preserve saved landing identities and require authority for incoming repairs.
Apply the same source-path normalization and Wiki index-route aliases across
compilation, navigation, and source writing. Repair saved cross-source folder
links when newly declared public routes shadow them, and validate out-of-root
folder cards through the usual link policy.
Keep valid public route slugs independent of filesystem-name restrictions and
diagnose malformed folder pathnames without decoding opaque query strings.

`discoverCourseResources` exposes authoring metadata and paths for consumers that
combine declared resource inventories before link and Asset compilation.
