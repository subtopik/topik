/**
 * Generators of Wiki source projects for write-back property tests. Test-only: nothing here is
 * exported by the package entry, so none of it is published.
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
  ];
}
