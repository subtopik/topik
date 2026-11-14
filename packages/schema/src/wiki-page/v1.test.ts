import { testSchema } from "../test-utils";
import wikiPageV1Schema from "./v1.json" with { type: "json" };

testSchema("wiki-page", wikiPageV1Schema, { formats: true });
