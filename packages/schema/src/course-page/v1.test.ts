import { testSchema } from "../test-utils";
import coursePageV1Schema from "./v1.json" with { type: "json" };

testSchema("course-page", coursePageV1Schema, { formats: true });
