export const PLAN_PATH = "release/alpha-plan.json";
export const NODE_ENGINES = "^22.12.0 || ^24.0.0";
export const NPM_CLI_VERSION = "11.13.0";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const RELEASE_CONCURRENCY_GROUP = "topik-alpha-release";

export const PUBLIC_PACKAGES = Object.freeze([
  "@topik/content-schema",
  "@topik/schema",
  "@topik/core",
  "@topik/content-react",
  "@topik/cli",
  "@topik/codemod",
]);

export const PACKAGE_DIRECTORIES = Object.freeze({
  "@topik/content-schema": "packages/content-schema",
  "@topik/schema": "packages/schema",
  "@topik/core": "packages/core",
  "@topik/content-react": "packages/content-react",
  "@topik/cli": "packages/cli",
  "@topik/codemod": "packages/codemod",
});

export const EXTERNAL_RUNTIME_DEPENDENCIES = Object.freeze({
  "@topik/content-schema": Object.freeze({
    "@markdoc/markdoc": "0.5.9",
    entities: "4.5.0",
    "github-slugger": "2.0.0",
  }),
  "@topik/schema": Object.freeze({}),
  "@topik/core": Object.freeze({
    ajv: "8.20.0",
    "ajv-formats": "3.0.1",
    chokidar: "5.0.0",
    yaml: "2.9.0",
    zod: "4.4.3",
  }),
  "@topik/content-react": Object.freeze({
    "@markdoc/markdoc": "0.5.9",
  }),
  "@topik/cli": Object.freeze({
    "@drizzle-team/brocli": "0.12.0",
    yaml: "2.9.0",
  }),
  "@topik/codemod": Object.freeze({
    "@drizzle-team/brocli": "0.12.0",
  }),
});

export const RESOURCE_VERSIONS = Object.freeze([
  "Asset/v1",
  "Course/v1",
  "CourseModule/v1",
  "CoursePage/v1",
  "Guide/v1",
  "Person/v1",
  "Wiki/v1",
  "WikiPage/v1",
]);

export const FEATURE_FLOORS = Object.freeze([
  "automatic-asset-identity",
  "fail-closed-invalid-and-unsupported-content",
]);

export const RELEASE_VERSION_PATTERN = /^0\.1\.0-alpha\.[1-9][0-9]*$/u;
export const IMMUTABLE_TAG_PATTERN = /^v0\.1\.0-alpha\.[1-9][0-9]*$/u;
export const SRI_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
