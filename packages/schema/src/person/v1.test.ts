import { testSchema } from "../test-utils";
import personV1Schema from "./v1.json" with { type: "json" };

testSchema("person", personV1Schema, { formats: true });
