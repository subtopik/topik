---
"@topik/content": patch
---

Refuse external asset URLs that rendering would drop. An HTTPS image, figure or download URL with trailing whitespace or a fragment that is not valid percent-encoded UTF-8, such as `https://example.com/a.png#%E9`, now fails validation and compilation with `TOPIK_EXTERNAL_REFERENCE_UNSAFE`. Before, it was admitted and then removed without a diagnostic when the content was rendered, leaving the image without a source.
