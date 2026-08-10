import type {
  Asset,
  Course,
  CourseModule,
  CoursePage,
  Guide,
  Person,
  Wiki,
  WikiPage,
} from "@topik/schema";

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
