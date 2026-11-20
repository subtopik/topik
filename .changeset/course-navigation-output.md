---
"@topik/cli": patch
---

`topik compile` writes `course-navigation.json` for a project with Courses. It records where each module and page was declared, as `{ "descriptor": "topik-course-navigation-v1", "courses": … }`, so a consumer of the output can order modules and pages that share an `order` value by their declaration order, as preview and the compile result already allow. A project without Courses gets no such file, and `topik validate` skips it like the other inventories.
