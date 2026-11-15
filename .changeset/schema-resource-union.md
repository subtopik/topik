---
"@topik/schema": patch
---

Publish a `Resource` union of every v1 resource envelope as
`@topik/schema/resource/v1.json`, with the `Resource` type at
`@topik/schema/resource/v1`. The envelope's `type` selects the referenced resource
schema, and an unknown `type` fails at `/type` with the supported values.
