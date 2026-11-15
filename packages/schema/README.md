# @topik/schema

JSON Schema (draft 2020-12) definitions and generated TypeScript types for Topik
resource envelopes: `Asset`, `Course`, `CourseModule`, `CoursePage`, `Guide`,
`Person`, `Wiki`, and `WikiPage`, plus a `Resource` union of all of them. Each
resource has `apiVersion`, `type`, `name`, and a kind-specific `spec`.

## Install

```sh
npm install @topik/schema
```

## Usage

Each schema is published as `@topik/schema/<resource>/v1.json`, with types at
`@topik/schema/<resource>/v1`. Validate with any draft 2020-12 validator that
supports the `email` and `uri` formats. With Ajv, whose default strict mode rejects
unknown formats, register them with `ajv-formats`:

```ts
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import guideSchema from "@topik/schema/guide/v1.json" with { type: "json" };
import type { Guide } from "@topik/schema/guide/v1";

const guide: Guide = {
  apiVersion: "v1",
  type: "Guide",
  name: "getting-started",
  spec: {
    title: "Getting started",
    slug: "getting-started",
    content: { format: "topik", value: "# Getting started" },
  },
};

const ajv = new Ajv2020();
addFormats(ajv);
const validate = ajv.compile(guideSchema);
if (!validate(guide)) throw new Error(JSON.stringify(validate.errors));
```

### Any resource

`@topik/schema/resource/v1.json` accepts any v1 resource envelope, and
`@topik/schema/resource/v1` exports the matching `Resource` union type. The
envelope's `type` selects the resource schema, and an unknown `type` fails at
`/type` with the supported values. The union references the resource schemas by
`$id` instead of copying them, so add them to the validator before compiling it:

```ts
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import assetSchema from "@topik/schema/asset/v1.json" with { type: "json" };
import courseSchema from "@topik/schema/course/v1.json" with { type: "json" };
import courseModuleSchema from "@topik/schema/course-module/v1.json" with { type: "json" };
import coursePageSchema from "@topik/schema/course-page/v1.json" with { type: "json" };
import guideSchema from "@topik/schema/guide/v1.json" with { type: "json" };
import personSchema from "@topik/schema/person/v1.json" with { type: "json" };
import resourceSchema from "@topik/schema/resource/v1.json" with { type: "json" };
import wikiSchema from "@topik/schema/wiki/v1.json" with { type: "json" };
import wikiPageSchema from "@topik/schema/wiki-page/v1.json" with { type: "json" };
import type { Resource } from "@topik/schema/resource/v1";

const ajv = new Ajv2020();
addFormats(ajv);
ajv.addSchema([
  assetSchema,
  courseSchema,
  courseModuleSchema,
  coursePageSchema,
  guideSchema,
  personSchema,
  wikiSchema,
  wikiPageSchema,
]);
const validateResource = ajv.compile<Resource>(resourceSchema);
```

[`@topik/core`](https://github.com/subtopik/topik/tree/main/packages/core) also
validates resource envelopes with `validateResources`.

## Documentation

- [Resources](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT
