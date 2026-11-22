/**
 * Generators of source projects for write-back property tests: a Wiki and, optionally, a Guide
 * collection. Test-only: nothing here is exported by the package entry, so none of it is
 * published.
 *
 * A project is generated as a model (navigation, pages, configuration) and rendered to source
 * files in the spellings the writer must preserve: block or flow navigation, shorthand or
 * mapping page entries, plain or quoted scalars, comments, unrecognized frontmatter keys, CRLF
 * line endings, byte order marks and `.mdx` pages. Pages link to each other through relative
 * paths, so moves and deletions exercise reference repair.
 */
import { posix } from "node:path";
import fc from "fast-check";
import {
  document as topikDocument,
  render as renderTopik,
  type Document as TopikDocument,
} from "../../../content/src/testing/grammar.js";
import type { SourceTreeFile } from "../source/project.js";

export interface PageModel {
  /** Index into the project's page list; stable across renders. */
  index: number;
  explicitId: boolean;
  /** Frontmatter title; otherwise the title comes from the first heading. */
  title: string | null;
  heading: string;
  description: string | null;
  /** An unrecognized frontmatter key, kept in the file and not interpreted. */
  extra: boolean;
  comment: boolean;
  bom: boolean;
  ext: ".md" | ".mdx";
  /** Paragraphs of words and links; a link names another page by index. */
  paragraphs: ({ word: string } | { link: number })[][];
  /**
   * A document from the content grammar, written after the heading and paragraphs. Its
   * internal links are respelled to point at the next page.
   */
  document: TopikDocument | null;
  /** Whether the page shows the project's local image. */
  image: boolean;
}

export type NavModel =
  | { kind: "page"; slug: string; mapping: boolean; page: PageModel }
  | { kind: "group"; title: string; slug: string | null; children: NavModel[] }
  | { kind: "link"; title: string; href: string };

export interface WikiProjectModel {
  configDir: "" | "docs";
  configFile: "wiki.yaml" | "wiki.yml" | "wiki.json";
  id: string;
  title: string;
  description: string | null;
  navigation: NavModel[];
  eol: "\n" | "\r\n";
  comments: boolean;
  quote: "plain" | "double" | "single";
  flow: boolean;
  configBom: boolean;
}

const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);
const SLUGS = ["index", "intro", "setup", "usage", "faq", "guide"] as const;
const GROUP_SLUGS = ["content", "reference", "more"] as const;
const TITLES = ["Intro", "Getting started", "Set up: the basics", "FAQ", "Usage #1"] as const;
const WORDS = ["Read", "the", "notes", "first.", "Then", "continue"] as const;

const page: fc.Arbitrary<Omit<PageModel, "index">> = fc.record({
  explicitId: fc.boolean(),
  title: fc.option(pick(TITLES)),
  heading: pick(TITLES),
  description: fc.option(pick(["A short summary.", "Notes: more"])),
  extra: fc.boolean(),
  comment: fc.constantFrom(true, true, false),
  bom: fc.boolean(),
  ext: fc.constantFrom<".md" | ".mdx">(".md", ".md", ".md", ".mdx"),
  document: fc.option(topikDocument, { freq: 2 }),
  image: fc.constantFrom(true, false, false),
  paragraphs: fc.array(
    fc.array(
      fc.oneof(
        { arbitrary: pick(WORDS).map((word) => ({ word })), weight: 4 },
        { arbitrary: fc.nat(8).map((link) => ({ link })), weight: 1 },
      ),
      { minLength: 1, maxLength: 6 },
    ),
    { maxLength: 3 },
  ),
});

type RawNav =
  | { kind: "page"; slug: string; mapping: boolean; page: Omit<PageModel, "index"> }
  | { kind: "group"; title: string; slug: string | null; children: RawNav[] }
  | { kind: "link"; title: string; href: string };

const { navigation } = fc.letrec<{ node: RawNav; navigation: RawNav[] }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 2, depthIdentifier: "wiki-navigation" },
    fc.record({
      kind: fc.constant("page" as const),
      slug: pick(SLUGS),
      mapping: fc.boolean(),
      page,
    }),
    fc.record({
      kind: fc.constant("group" as const),
      title: pick(["Content", "Reference"]),
      slug: fc.option(pick(GROUP_SLUGS)),
      children: tie("navigation"),
    }),
    fc.record({
      kind: fc.constant("link" as const),
      title: pick(["Source code", "Site"]),
      href: pick(["https://e.test", "https://e.test/a"]),
    }),
  ),
  navigation: fc.array(tie("node"), { minLength: 1, maxLength: 4 }),
}));

/**
 * Number the pages and make source paths and routes unique: a repeated slug in one directory
 * takes a numeric suffix, a group without pages is dropped, and the project has a page.
 */
function normalize(raw: readonly RawNav[]): NavModel[] {
  const used = new Set<string>();
  let next = 0;
  const visit = (nodes: readonly RawNav[], dir: string): NavModel[] =>
    nodes.flatMap((node): NavModel[] => {
      if (node.kind === "link") return [node];
      if (node.kind === "group") {
        const children = visit(node.children, node.slug ? posix.join(dir, node.slug) : dir);
        return children.some((child) => child.kind !== "link") ? [{ ...node, children }] : [];
      }
      let slug = node.slug;
      for (let suffix = 2; used.has(posix.join(dir, slug)); suffix++)
        slug = `${node.slug}${suffix}`;
      used.add(posix.join(dir, slug));
      return [{ ...node, slug, page: { ...node.page, index: next++ } }];
    });
  const nodes = visit(raw, "");
  return nodes.some((node) => node.kind !== "link")
    ? nodes
    : [
        ...nodes,
        {
          kind: "page",
          slug: "intro",
          mapping: false,
          page: {
            index: next,
            explicitId: true,
            title: null,
            heading: "Intro",
            description: null,
            extra: false,
            comment: false,
            bom: false,
            ext: ".md",
            paragraphs: [],
            document: null,
            image: false,
          },
        },
      ];
}

export const wikiProject: fc.Arbitrary<WikiProjectModel> = fc.record({
  configDir: fc.constantFrom<"" | "docs">("", "docs"),
  configFile: fc.constantFrom<WikiProjectModel["configFile"]>(
    "wiki.yaml",
    "wiki.yaml",
    "wiki.yml",
    "wiki.json",
  ),
  id: pick(["docs", "handbook"]),
  title: pick(["Docs", "Team handbook", "Docs: v2"]),
  description: fc.option(pick(["All the docs."])),
  navigation: navigation.map(normalize),
  eol: fc.constantFrom<"\n" | "\r\n">("\n", "\n", "\r\n"),
  comments: fc.boolean(),
  quote: fc.constantFrom<WikiProjectModel["quote"]>("plain", "double", "single"),
  flow: fc.boolean(),
  configBom: fc.boolean(),
});

/** Every page of a project with its source path relative to the project root. */
export function pages(model: WikiProjectModel): { page: PageModel; path: string; slug: string }[] {
  const result: { page: PageModel; path: string; slug: string }[] = [];
  const visit = (nodes: readonly NavModel[], dir: string) => {
    for (const node of nodes) {
      if (node.kind === "group") visit(node.children, node.slug ? posix.join(dir, node.slug) : dir);
      else if (node.kind === "page")
        result.push({
          page: node.page,
          slug: posix.join(dir, node.slug),
          path: posix.join(model.configDir, dir, `${node.slug}${node.page.ext}`),
        });
    }
  };
  visit(model.navigation, "");
  return result.sort((a, b) => a.page.index - b.page.index);
}

/** A YAML scalar in the project's quoting style; values that need quotes always get them. */
function scalar(value: string, quote: WikiProjectModel["quote"]): string {
  if (quote === "single") return `'${value.replaceAll("'", "''")}'`;
  if (quote === "double" || /[:#]/u.test(value)) return JSON.stringify(value);
  return value;
}

function navigationYaml(
  nodes: readonly NavModel[],
  model: WikiProjectModel,
  indent: string,
): string[] {
  const q = (value: string) => scalar(value, model.quote);
  if (model.flow) {
    const flow = (node: NavModel): string =>
      node.kind === "page"
        ? node.mapping
          ? `{type: page, slug: ${node.slug}}`
          : node.slug
        : node.kind === "link"
          ? `{type: link, title: ${q(node.title)}, href: ${JSON.stringify(node.href)}}`
          : `{type: group, title: ${q(node.title)}${node.slug ? `, slug: ${node.slug}` : ""}, children: [${node.children.map(flow).join(", ")}]}`;
    return [`${indent}[${nodes.map(flow).join(", ")}]`];
  }
  return nodes.flatMap((node, index) => {
    const comment = model.comments && index === 0 ? [`${indent}# entries`] : [];
    if (node.kind === "page")
      return [
        ...comment,
        ...(node.mapping
          ? [`${indent}- type: page`, `${indent}  slug: ${node.slug}`]
          : [`${indent}- ${node.slug}`]),
      ];
    if (node.kind === "link")
      return [
        ...comment,
        `${indent}- type: link`,
        `${indent}  title: ${q(node.title)}`,
        `${indent}  href: ${node.href}`,
      ];
    return [
      ...comment,
      `${indent}- type: group`,
      `${indent}  title: ${q(node.title)}`,
      ...(node.slug ? [`${indent}  slug: ${node.slug}`] : []),
      `${indent}  children:`,
      ...navigationYaml(node.children, model, `${indent}    `),
    ];
  });
}

function configuration(model: WikiProjectModel): string {
  if (model.configFile === "wiki.json") {
    const json = (nodes: readonly NavModel[]): unknown[] =>
      nodes.map((node) =>
        node.kind === "page"
          ? node.mapping
            ? { type: "page", slug: node.slug }
            : node.slug
          : node.kind === "link"
            ? { type: "link", title: node.title, href: node.href }
            : {
                type: "group",
                title: node.title,
                ...(node.slug ? { slug: node.slug } : {}),
                children: json(node.children),
              },
      );
    const value = {
      id: model.id,
      title: model.title,
      ...(model.description ? { description: model.description } : {}),
      navigation: json(model.navigation),
    };
    return `${JSON.stringify(value, null, 2)}\n`.replaceAll("\n", model.eol);
  }
  const q = (value: string) => scalar(value, model.quote);
  const lines = [
    ...(model.comments ? ["# Wiki configuration"] : []),
    `id: ${model.id}`,
    `title: ${q(model.title)}${model.comments ? " # shown in the header" : ""}`,
    ...(model.description ? [`description: ${q(model.description)}`] : []),
    ...(model.flow
      ? [`navigation: ${navigationYaml(model.navigation, model, "")[0]}`]
      : ["navigation:", ...navigationYaml(model.navigation, model, "  ")]),
  ];
  return `${lines.join(model.eol)}${model.eol}`;
}

function markdown(
  model: WikiProjectModel,
  entry: { page: PageModel; path: string },
  all: readonly { page: PageModel; path: string }[],
): string {
  const { page } = entry;
  const q = (value: string) => scalar(value, model.quote);
  const fields = [
    ...(page.explicitId ? [`id: page-${page.index}`] : []),
    ...(page.comment ? ["# page notes"] : []),
    ...(page.title ? [`title: ${q(page.title)}`] : []),
    ...(page.description ? [`description: ${q(page.description)}`] : []),
    ...(page.extra ? ["owner: docs-team"] : []),
  ];
  const link = (index: number) => {
    const target = all[index % all.length];
    const href = posix.relative(posix.dirname(entry.path), target.path);
    return `[link](${href.startsWith(".") ? href : `./${href}`})`;
  };
  const paragraphs = page.paragraphs.map((words) =>
    words.map((token) => ("word" in token ? token.word : link(token.link))).join(" "),
  );
  const next = all[(page.index + 1) % all.length];
  const relative = posix.relative(posix.dirname(entry.path), next.path);
  const generated = page.document
    ? renderTopik(page.document, {
        href: (href) =>
          href.startsWith("https://")
            ? href
            : relative.startsWith(".")
              ? relative
              : `./${relative}`,
        // Local media needs Asset files; these pages use remote media instead.
        media: (src) =>
          src.startsWith("https://") ? src : `https://e.test/${posix.basename(src)}`,
      })
    : undefined;
  const lines = [
    ...(fields.length ? ["---", ...fields, "---"] : []),
    `# ${page.heading}`,
    ...paragraphs.flatMap((paragraph) => ["", paragraph]),
    ...(page.image
      ? ["", `![Diagram](${posix.relative(posix.dirname(entry.path), imagePath(model))})`]
      : []),
    ...(generated ? ["", ...generated.split("\n")] : []),
  ];
  return `${page.bom ? "﻿" : ""}${lines.join(model.eol)}${model.eol}`;
}

const encoder = new TextEncoder();
const file = (path: string, text: string): SourceTreeFile => ({
  path,
  mode: "100644",
  bytes: encoder.encode(text),
});

/** A 1x1 PNG: the bytes of the project's local image. */
export const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (character) => character.charCodeAt(0),
);
/** Another 1x1 PNG, for media an edit adds. */
export const PNG_ADDED = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
/** Where a project's local image lives, inside the Wiki configuration's directory. */
export const imagePath = (model: WikiProjectModel) =>
  posix.join(model.configDir, "images", "diagram.png");

/** The configuration file's path relative to the project root. */
export const configPath = (model: WikiProjectModel) =>
  posix.join(model.configDir, model.configFile);

/** Render a project to the source tree `readSourceProject` reads. */
export function renderWikiProject(model: WikiProjectModel): SourceTreeFile[] {
  const all = pages(model);
  return [
    file(
      ".topik.yaml",
      `version: 1\nnamespace: demo/fuzz\nsources: [{kind: wiki, config: ${configPath(model)}}]\n`,
    ),
    file(configPath(model), `${model.configBom ? "﻿" : ""}${configuration(model)}`),
    ...all.map((entry) => file(entry.path, markdown(model, entry, all))),
    ...(all.some((entry) => entry.page.image)
      ? [{ path: imagePath(model), mode: "100644" as const, bytes: PNG }]
      : []),
  ];
}

export interface GuideModel {
  index: number;
  slug: string;
  explicitId: boolean;
  title: string | null;
  heading: string;
  description: string | null;
  /** Frontmatter tags, in flow or block spelling. */
  tags: { values: string[]; flow: boolean } | null;
  extra: boolean;
  comment: boolean;
  bom: boolean;
  ext: ".md" | ".mdx";
  /** A link to another guide of the collection, by index. */
  link: number | null;
  document: TopikDocument | null;
  /** Authors, as indexes into the collection's persons. */
  authors: number[];
}

export interface PersonModel {
  id: string;
  name: string;
  email: string | null;
  /** The record's `spec` as a flow mapping rather than a block. */
  flow: boolean;
}

export interface CollectionModel {
  dir: "guides" | "blog";
  id: "tutorials" | "blog";
  title: string;
  guides: GuideModel[];
  /** A repository readme beside the configuration: never a guide, and never written. */
  readme: boolean;
  persons: PersonModel[];
  comments: boolean;
  eol: "\n" | "\r\n";
}

export interface CoursePageModel {
  index: number;
  /** Source path relative to the Course configuration, without extension. */
  file: string;
  slug: string;
  title: string;
  description: string | null;
  extra: boolean;
  comment: boolean;
  bom: boolean;
  ext: ".md" | ".mdx";
  /** A link to another page by index: by relative source path or by public route. */
  link: { page: number; route: boolean } | null;
  document: TopikDocument | null;
}

export interface CourseModel {
  id: "learning" | "course";
  title: string;
  modules: { id: string; title: string; flow: boolean; pages: CoursePageModel[] }[];
  comments: boolean;
  eol: "\n" | "\r\n";
}

export interface SourceProjectModel {
  wiki: WikiProjectModel;
  collection: CollectionModel | null;
  course: CourseModel | null;
}

/** A generated document on one page in three: each can break a rule its project enforces. */
const sometimes = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: topikDocument },
);

const GUIDE_SLUGS = ["intro", "setup", "basics", "tips"] as const;

const collection: fc.Arbitrary<CollectionModel> = fc.record({
  dir: fc.constantFrom<"guides" | "blog">("guides", "blog"),
  id: fc.constantFrom<"tutorials" | "blog">("tutorials", "blog"),
  title: pick(["Tutorials", "Blog: notes"]),
  guides: fc
    .uniqueArray(
      fc.record({
        slug: pick(GUIDE_SLUGS),
        explicitId: fc.boolean(),
        title: fc.option(pick(TITLES)),
        heading: pick(TITLES),
        description: fc.option(pick(["A short summary."])),
        tags: fc.option(
          fc.record({
            values: fc.uniqueArray(pick(["setup", "basics", "news"]), {
              minLength: 1,
              maxLength: 2,
            }),
            flow: fc.boolean(),
          }),
        ),
        extra: fc.boolean(),
        comment: fc.constantFrom(true, true, false),
        bom: fc.boolean(),
        ext: fc.constantFrom<".md" | ".mdx">(".md", ".md", ".mdx"),
        link: fc.option(fc.nat(3)),
        document: sometimes,
        authors: fc.uniqueArray(fc.nat(2), { maxLength: 2 }),
      }),
      { minLength: 1, maxLength: 3, selector: (guide) => guide.slug },
    )
    .map((guides) => guides.map((guide, index) => ({ ...guide, index }))),
  readme: fc.boolean(),
  persons: fc.uniqueArray(
    fc.record({
      id: pick(["ada", "alan", "grace"]),
      name: pick(["Ada Lovelace", "Alan Turing", "Grace Hopper"]),
      email: fc.option(pick(["team@e.test"])),
      flow: fc.boolean(),
    }),
    { maxLength: 3, selector: (person) => person.id },
  ),
  comments: fc.boolean(),
  eol: fc.constantFrom<"\n" | "\r\n">("\n", "\n", "\r\n"),
});

const MODULES = ["foundations", "advanced", "extras"] as const;
const COURSE_SLUGS = ["introduction", "practice", "review", "summary", "quiz"] as const;

const coursePage = fc.record({
  slug: pick(COURSE_SLUGS),
  title: pick(TITLES),
  description: fc.option(pick(["A short summary."])),
  extra: fc.boolean(),
  comment: fc.constantFrom(true, true, false),
  bom: fc.boolean(),
  ext: fc.constantFrom<".md" | ".mdx">(".md", ".md", ".mdx"),
  link: fc.option(fc.record({ page: fc.nat(8), route: fc.boolean() })),
  document: sometimes,
});

const course: fc.Arbitrary<CourseModel> = fc
  .record({
    id: fc.constantFrom<CourseModel["id"]>("learning", "course"),
    title: pick(["Learning", "Course: basics"]),
    modules: fc.uniqueArray(
      fc.record({
        id: pick(MODULES),
        title: pick(["Foundations", "Going further", "Extras"]),
        flow: fc.boolean(),
        pages: fc.uniqueArray(coursePage, {
          minLength: 1,
          maxLength: 3,
          selector: (page) => page.slug,
        }),
      }),
      { minLength: 1, maxLength: 3, selector: (module) => module.id },
    ),
    comments: fc.boolean(),
    eol: fc.constantFrom<"\n" | "\r\n">("\n", "\n", "\r\n"),
  })
  .map((model) => {
    // Number the pages and give each a file of its own.
    let index = 0;
    return {
      ...model,
      modules: model.modules.map((module) => ({
        ...module,
        pages: module.pages.map((page) => ({
          ...page,
          index: index++,
          file: `lessons/${module.id}-${page.slug}`,
        })),
      })),
    };
  });

export const sourceProject: fc.Arbitrary<SourceProjectModel> = fc.record({
  wiki: wikiProject,
  collection: fc.option(collection, { freq: 3 }),
  course: fc.option(course, { freq: 3 }),
});

/** The Course configuration's path relative to the project root. */
export const courseConfigPath = (model: CourseModel) => posix.join("course", `${model.id}.yaml`);

/** Every Course page with its module, id and source path relative to the project root. */
export function coursePages(
  model: CourseModel,
): { page: CoursePageModel; module: string; id: string; path: string }[] {
  return model.modules.flatMap((module) =>
    module.pages.map((page) => ({
      page,
      module: module.id,
      id: `${module.id}-${page.slug}`,
      path: posix.join("course", `${page.file}${page.ext}`),
    })),
  );
}

function coursePageMarkdown(
  model: CourseModel,
  entry: ReturnType<typeof coursePages>[number],
): string {
  const { page } = entry;
  const all = coursePages(model);
  const relative = (index: number) => {
    const target = all[index % all.length];
    return `./${posix.relative(posix.dirname(entry.path), target.path)}`;
  };
  const route = (index: number) => {
    const target = all[index % all.length];
    return `/${target.module}/${target.page.slug}`;
  };
  const fields = [
    `id: ${entry.id}`,
    ...(page.comment ? ["# lesson notes"] : []),
    `title: ${scalar(page.title, "plain")}`,
    `slug: ${page.slug}`,
    ...(page.description ? [`description: ${page.description}`] : []),
    ...(page.extra ? ["level: beginner"] : []),
  ];
  const generated = page.document
    ? renderTopik(page.document, {
        href: (href) => (href.startsWith("https://") ? href : relative(page.index + 1)),
        media: (src) =>
          src.startsWith("https://") ? src : `https://e.test/${posix.basename(src)}`,
      })
    : undefined;
  const lines = [
    "---",
    ...fields,
    "---",
    `# ${page.title}`,
    ...(page.link === null
      ? []
      : [
          "",
          `Continue with [the next lesson](${page.link.route ? route(page.link.page) : relative(page.link.page)}).`,
        ]),
    ...(generated ? ["", ...generated.split("\n")] : []),
  ];
  return `${page.bom ? "\uFEFF" : ""}${lines.join(model.eol)}${model.eol}`;
}

function courseConfiguration(model: CourseModel): string {
  const lines = [
    `id: ${model.id}`,
    `title: ${scalar(model.title, "plain")}`,
    `slug: ${model.id}`,
    ...(model.comments ? ["# Modules in reading order"] : []),
    "modules:",
    ...model.modules.flatMap((module) => [
      `  - id: ${module.id}`,
      `    title: ${module.title}`,
      `    slug: ${module.id}`,
      ...(module.flow
        ? [`    pages: [${module.pages.map((page) => page.file).join(", ")}]`]
        : ["    pages:", ...module.pages.map((page) => `      - ${page.file}`)]),
    ]),
  ];
  return `${lines.join(model.eol)}${model.eol}`;
}

/** The collection configuration's path relative to the project root. */
export const collectionConfigPath = (model: CollectionModel) =>
  posix.join(model.dir, "collection.yaml");

/** Every guide of a collection with its source path relative to the project root. */
export function guides(model: CollectionModel): { guide: GuideModel; path: string }[] {
  return model.guides.map((guide) => ({
    guide,
    path: posix.join(model.dir, `${guide.slug}${guide.ext}`),
  }));
}

function guideMarkdown(model: CollectionModel, entry: { guide: GuideModel; path: string }): string {
  const { guide } = entry;
  const all = guides(model);
  // Authors refer to declared persons; indexes past the list name nobody.
  const authorIds = guide.authors.flatMap((index) =>
    model.persons[index] ? [model.persons[index].id] : [],
  );
  const fields = [
    ...(guide.explicitId ? [`id: guide-${guide.index}`] : []),
    ...(guide.comment ? ["# guide notes"] : []),
    ...(guide.title ? [`title: ${scalar(guide.title, "plain")}`] : []),
    ...(guide.description ? [`description: ${guide.description}`] : []),
    ...(guide.tags
      ? guide.tags.flow
        ? [`tags: [${guide.tags.values.join(", ")}]`]
        : ["tags:", ...guide.tags.values.map((tag) => `  - ${tag}`)]
      : []),
    ...(guide.extra ? ["reviewed: true"] : []),
    ...(authorIds.length ? [`authors: [${authorIds.join(", ")}]`] : []),
  ];
  const target = (index: number) => {
    const other = all[index % all.length];
    return `./${posix.basename(other.path)}`;
  };
  const generated = guide.document
    ? renderTopik(guide.document, {
        href: (href) => (href.startsWith("https://") ? href : target(guide.index + 1)),
        media: (src) =>
          src.startsWith("https://") ? src : `https://e.test/${posix.basename(src)}`,
      })
    : undefined;
  const lines = [
    ...(fields.length ? ["---", ...fields, "---"] : []),
    `# ${guide.heading}`,
    ...(guide.link === null ? [] : ["", `Continue with [the next guide](${target(guide.link)}).`]),
    ...(generated ? ["", ...generated.split("\n")] : []),
  ];
  return `${guide.bom ? "\uFEFF" : ""}${lines.join(model.eol)}${model.eol}`;
}

function collectionConfiguration(model: CollectionModel): string {
  const lines = [
    `id: ${model.id}`,
    ...(model.comments ? ["# Guides for new readers"] : []),
    `title: ${scalar(model.title, "plain")}`,
    ...(model.persons.length
      ? [
          "persons:",
          ...(model.comments ? ["  # authors"] : []),
          ...model.persons.flatMap((person) =>
            person.flow
              ? [
                  `  - id: ${person.id}`,
                  `    spec: {name: ${person.name}${person.email ? `, email: ${person.email}` : ""}}`,
                ]
              : [
                  `  - id: ${person.id}`,
                  "    spec:",
                  `      name: ${person.name}`,
                  ...(person.email ? [`      email: ${person.email}`] : []),
                ],
          ),
        ]
      : []),
  ];
  return `${lines.join(model.eol)}${model.eol}`;
}

/** Render a project with all its sources to the tree `readSourceProject` reads. */
export function renderSourceProject(model: SourceProjectModel): SourceTreeFile[] {
  const wiki = renderWikiProject(model.wiki).slice(1);
  const sources = [
    `  - {kind: wiki, config: ${configPath(model.wiki)}}`,
    ...(model.collection
      ? [`  - {kind: collection, config: ${collectionConfigPath(model.collection)}}`]
      : []),
    ...(model.course ? [`  - {kind: course, config: ${courseConfigPath(model.course)}}`] : []),
  ];
  return [
    file(".topik.yaml", `version: 1\nnamespace: demo/fuzz\nsources:\n${sources.join("\n")}\n`),
    ...wiki,
    ...(model.collection
      ? [
          file(collectionConfigPath(model.collection), collectionConfiguration(model.collection)),
          ...guides(model.collection).map((entry) =>
            file(entry.path, guideMarkdown(model.collection!, entry)),
          ),
          ...(model.collection.readme
            ? [
                file(
                  posix.join(model.collection.dir, "README.md"),
                  "Repository notes, not a guide.\n",
                ),
              ]
            : []),
        ]
      : []),
    ...(model.course
      ? [
          file(courseConfigPath(model.course), courseConfiguration(model.course)),
          ...coursePages(model.course).map((entry) =>
            file(entry.path, coursePageMarkdown(model.course!, entry)),
          ),
        ]
      : []),
  ];
}
