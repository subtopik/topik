---
"@topik/core": patch
---

One set of rules across the core compilers.

Breaking:

- `compileWiki`, `compileGuides` and `compileCourse` accept `fileSafety` and `gitExecutable` like `compile`, share one read session per call, and read a conventionally named configuration (`wiki.yaml`, `collection.json`, …) with the same reader and parser as a selected one.
- A page source that exists as both `.md` and `.mdx` fails with `wiki-page-ambiguous` or `course-page-ambiguous` at the `.mdx` file, with `relatedLocation` naming the `.md` file, for Wikis and Courses alike.
- An Asset value that is not topik-json-v1 data, such as a negative or fractional `size`, is reported at that value's JSON Pointer with the reason.

Resource names and slugs are checked everywhere with the pattern and lengths the resource schemas declare.
