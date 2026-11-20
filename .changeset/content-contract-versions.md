---
"@topik/content": patch
---

Breaking: `TOPIK_CONTENT_SCHEMA_VERSION` is `0.3.0` and `FORMAT_VERSION` is `2`. This release removes `cardGrid`, adds canonical components and changes the canonical Markdown the formatter writes, so content written for schema `0.2.2` and format `1` needs review. Passing format version `1` to `parseDocument` or `writeDocument` is refused with `Unsupported format version 1`.
