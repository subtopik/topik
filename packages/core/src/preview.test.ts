import { expectTypeOf, test } from "vite-plus/test";
import type { Guide } from "@topik/schema/guide/v1";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { Resource as RootResource } from "./index";
import type { PreviewState, Resource } from "./preview";
import type { Watcher } from "./watch";

test("PreviewState defaults to the schema-generated resource union", () => {
  expectTypeOf<PreviewState>().toEqualTypeOf<PreviewState<Resource>>();
  expectTypeOf<PreviewState["resources"]>().toEqualTypeOf<Resource[]>();
  expectTypeOf<Watcher["state"]>().toEqualTypeOf<PreviewState>();
});

test("the preview entry point names the same resource union as the package root", () => {
  expectTypeOf<Resource>().toEqualTypeOf<RootResource>();
  expectTypeOf<Wiki>().toExtend<Resource>();
  expectTypeOf<WikiPage>().toExtend<Resource>();
});

test("PreviewState accepts a consumer's own resource type", () => {
  type ValidatedResource = Wiki | WikiPage;
  type ValidatedState = PreviewState<ValidatedResource>;

  expectTypeOf<ValidatedState["resources"]>().toEqualTypeOf<ValidatedResource[]>();
  expectTypeOf<Omit<ValidatedState, "resources">>().toEqualTypeOf<
    Omit<PreviewState, "resources">
  >();
  expectTypeOf<ValidatedState>().toExtend<PreviewState>();

  const guide: Guide = {
    apiVersion: "v1",
    type: "Guide",
    name: "getting-started",
    spec: {
      title: "Getting started",
      slug: "getting-started",
      content: { format: "topik", value: "" },
    },
  };
  // @ts-expect-error a narrowed state rejects resources outside its union
  const narrowed: ValidatedState["resources"] = [guide];
  void narrowed;
});
