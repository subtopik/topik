# @topik/schema

JSON Schema (draft 2020-12) definitions and generated TypeScript types for Topik
resource envelopes: `Asset`, `Course`, `CourseModule`, `CoursePage`, `Guide`,
`Person`, `Wiki`, and `WikiPage`. Each resource has `apiVersion`, `type`, `name`,
and a kind-specific `spec`.

## Install

```sh
npm install @topik/schema
```

## Usage

Each schema is published as `@topik/schema/<resource>/v1.json`, with types at
`@topik/schema/<resource>/v1`. Validate with any draft 2020-12 validator, for
example Ajv:

```ts
import Ajv2020 from "ajv/dist/2020.js";
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

const validate = new Ajv2020().compile(guideSchema);
if (!validate(guide)) throw new Error(JSON.stringify(validate.errors));
```

[`@topik/core`](https://github.com/subtopik/topik/tree/main/packages/core) also
validates resource envelopes with `validateResources`.

## Documentation

- [Resources](https://github.com/subtopik/topik/blob/main/docs/resources/index.md)

Topik is alpha software; keep `@topik/*` packages on matching releases.

## License

MIT
