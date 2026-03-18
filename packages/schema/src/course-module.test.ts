import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { courseModuleSchema } from "./course-module";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

testSchema("course-module", ajv.compile(courseModuleSchema));
