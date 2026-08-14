import { createValidator, testSchema } from "../test-utils";
import personV1Schema from "./v1.json" with { type: "json" };

const ajv = createValidator({ formats: true });

testSchema("person", ajv.compile(personV1Schema));
