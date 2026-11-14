---
"@topik/content-react": patch
---

Clamp and validate code presentation line ranges in `TopikCodeBlock` and `RichTopikCodeBlock`, so out-of-range or malformed `presentation` props no longer crash rendering.
