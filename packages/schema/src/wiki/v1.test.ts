import { testSchema } from "../test-utils";
import wikiV1Schema from "./v1.json" with { type: "json" };

testSchema("wiki", wikiV1Schema, { formats: true, discriminator: true });
