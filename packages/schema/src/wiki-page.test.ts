import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { wikiPageSchema } from "./wiki-page";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

testSchema("wiki-page", ajv.compile(wikiPageSchema));
