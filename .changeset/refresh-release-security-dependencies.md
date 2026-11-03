---
"@topik/core": patch
"@topik/content": patch
---

Refresh transitive dependency resolutions for URI validation, release tooling, and Storybook documentation generation while preserving the public Node.js 22.12 compatibility floor.

Retain the Markdown parser's fix for adjacent nested emphasis so writing, formatting, and rewriting preserve the authored emphasis tree without rejecting valid source.
