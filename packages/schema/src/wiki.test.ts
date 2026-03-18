import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { wikiSchema } from "./wiki";
import { testSchema } from "./test-utils";

const ajv = new Ajv2020({ strict: true, discriminator: true });
addFormats(ajv);

testSchema("wiki", ajv.compile(wikiSchema));
