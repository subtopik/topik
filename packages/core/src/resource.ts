import type { Wiki, WikiPage } from "@topik/schema";

export type Resource = Wiki | WikiPage;

export type ResourceType = Resource["type"];
