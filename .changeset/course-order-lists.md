---
"@topik/schema": patch
"@topik/core": patch
"@topik/cli": patch
---

Order Courses by their lists, as Wikis are ordered by their navigation. A Course's `modules` and each module's `pages` give the reader order, and compiled resources carry the same lists.

- `Course.spec.modules` names the Course's modules and `CourseModule.spec.pages` names the module's pages, in reader order. The graph check (`topik validate --graph`, `validateResourceGraph`) requires each list to name exactly the children that name its parent, once each, and reports `membership-inconsistent` otherwise.
- The source writer edits these lists as it edits Wiki navigation: removed entries are deleted in place, added entries are appended, and a moved entry is written again.

Breaking: `spec.order` is removed from the `CourseModule` and `CoursePage` schemas, and `Course.spec.modules` and `CourseModule.spec.pages` are required. Course sources no longer take `order` on modules or in page frontmatter; an `order` left in a source fails with `config-invalid` or `frontmatter-invalid` naming the field. `courseNavigation` is removed from compile results, discovery and preview state, and the preview protocol is now `topik-preview/2`. A plan that adds a page or module must list it in its parent and update that parent. See "Migrate from 0.1.0-alpha.7" in the resources guide.
