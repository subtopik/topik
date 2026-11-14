import { testSchema } from "../test-utils";
import courseV1Schema from "./v1.json" with { type: "json" };

testSchema("course", courseV1Schema, { formats: true });
