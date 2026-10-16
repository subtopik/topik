---
"@topik/content-react": patch
---

Keep authored and resolved dark figure image URLs as single browser source
candidates. Escape source-set delimiters so a URL cannot introduce additional
image destinations when following the browser's dark color preference.
