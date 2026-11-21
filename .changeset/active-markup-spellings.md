---
"@topik/core": patch
---

Active-content checks read UTF-16 text that starts with a byte order mark, and recognize a `javascript:` URL spelled with character references, tabs or line breaks, such as `&#106;avascript:`. Such files are refused as HTML or SVG instead of being kept as downloads.
