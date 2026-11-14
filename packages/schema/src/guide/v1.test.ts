import { testSchema } from "../test-utils";
import guideV1Schema from "./v1.json" with { type: "json" };

testSchema("guide", guideV1Schema);
