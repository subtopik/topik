import type { Guide, Wiki, WikiPage } from "@topik/schema";

export type Resource = Guide | Wiki | WikiPage;

export type ResourceType = Resource["type"];
