---
"@topik/content": patch
---

Pad formatted table columns by display width instead of string length. Cells with emoji, CJK text or combining marks used to throw the pipes out of line in editors; they now line up and match Prettier's padding for those characters.
