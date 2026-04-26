import type { Asset, Guide, Wiki, WikiPage } from "@topik/schema";

export type Resource = Asset | Guide | Wiki | WikiPage;

export type ResourceType = Resource["type"];
