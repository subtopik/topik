import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { courseSchema } from "./course";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

testSchema("course", ajv.compile(courseSchema));
