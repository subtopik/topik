---
"@topik/core": patch
"@topik/cli": patch
---

Breaking: content and link diagnostics for a page with frontmatter count lines from the top of the file, so `topik lint`, `topik compile`, `topik dev` and the preview point at the line an editor shows. They used to count from the end of the frontmatter, so on a page with four frontmatter lines an error on line 8 was reported at line 4. Tools that added the frontmatter length themselves must stop doing so.
