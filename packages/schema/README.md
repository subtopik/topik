# @topik/schema

JSON Schema (draft 2020-12) definitions and generated TypeScript types for Topik
resource envelopes. A resource envelope is the object that carries one compiled
resource: it has `apiVersion`, `type`, `name`, and a `spec` whose shape depends on
the `type`. Use this package to validate resources and to type them in
TypeScript.

There is one schema for each resource type, `Asset`, `Course`, `CourseModule`,
`CoursePage`, `Guide`, `Person`, `Wiki`, and `WikiPage`, and a `Resource` union of
all of them.

## Install

```sh
npm install @topik/schema
```

## Usage

Each schema is published as `@topik/schema/<resource>/v1.json`, with its types at
`@topik/schema/<resource>/v1`. `<resource>` is the type name in lowercase with
hyphens, such as `guide` or `course-module`.

Validate with any draft 2020-12 validator that supports the `email` and `uri`
formats. Ajv rejects unknown formats in its default strict mode, so register them
with `ajv-formats`:

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
envelope's `type` selects the resource schema. An unknown `type` fails at `/type`
with the supported values.

The union schema refers to each resource schema by `$id` and does not contain it,
so add the resource schemas to the validator before you compile the union:

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
