import { createValidator, testSchema } from "../test-utils";
import guideV1Schema from "./v1.json" with { type: "json" };

const ajv = createValidator();

testSchema("guide", ajv.compile(guideV1Schema));
