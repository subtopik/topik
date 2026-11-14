import { testSchema } from "../test-utils";
import courseModuleV1Schema from "./v1.json" with { type: "json" };

testSchema("course-module", courseModuleV1Schema, { formats: true });
