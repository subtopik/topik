import type {
  Course,
  CourseModule,
  CoursePage,
  Guide,
  Person,
  Wiki,
  WikiPage,
} from "@topik/schema";

export type Resource = Course | CourseModule | CoursePage | Guide | Person | Wiki | WikiPage;

export type ResourceType = Resource["type"];
