import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { testSchema } from "../test-utils";
import wikiPageV1Schema from "./v1.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);

testSchema("wiki-page", ajv.compile(wikiPageV1Schema));
