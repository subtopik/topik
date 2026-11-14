---
"@topik/schema": patch
---

Person `spec.name` now requires at least one character, like titles in the other
resource schemas. The README validation example registers `ajv-formats`, which
Ajv's default strict mode needs for the `email` (Person) and `uri` (Wiki link)
formats, and type generation orders schemas by code point instead of the host
locale.
