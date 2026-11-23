---
"@topik/content": patch
"@topik/content-react": patch
---

Omit link, image, card, and asset attribute URLs that fail the Topik URL policy
when `transformTopikContent` renders unadmitted documents, and give headings
without sluggable text a deduplicated `section` anchor instead of an empty ID.
Render rich page math with explicit untrusted KaTeX options, a 20em dimension
limit, a bounded macro expansion budget, and isolated macros.
