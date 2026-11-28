---
"@topik/core": patch
"@topik/cli": patch
---

Tighten path containment and duplicate page identity checks. Subdirectories whose names start with `..` (such as `..docs`) are now treated as inside their parent directory in output scope and isolated-root checks, and wiki and course discovery now detect duplicate page IDs and course page slugs across invalid and valid pages before skipping invalid bodies.
