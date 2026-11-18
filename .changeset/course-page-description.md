---
"@topik/schema": patch
"@topik/core": patch
---

A Course page can carry a description. `CoursePage` accepts an optional `spec.description`, a string of at most 1024 characters or `null`, as `Course`, `CourseModule` and `WikiPage` do. `description` in a Course page's frontmatter compiles to it, an explicit `null` is kept, and the frontmatter is refused as `frontmatter-invalid` at `description` when the value is too long or not a string. Source planning and source initialization read and write the field: a page's `spec/description` has a field origin, and a plan adds, changes, clears or removes the frontmatter line and leaves the rest of the file unchanged. Before, the field was refused by the schema and by Course page frontmatter.
