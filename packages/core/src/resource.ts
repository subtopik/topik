import type { Asset } from "@topik/schema/asset/v1";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { Person } from "@topik/schema/person/v1";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";

export type Resource =
  | Asset
  | Course
  | CourseModule
  | CoursePage
  | Guide
  | Person
  | Wiki
  | WikiPage;

/** Resources accepted as compiler input. `Asset` exists only in compiler output. */
export type SourceResource = Exclude<Resource, Asset>;

export type ResourceType = Resource["type"];
