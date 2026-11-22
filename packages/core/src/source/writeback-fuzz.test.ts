/**
 * Property tests of source write-back over generated Wiki projects (see
 * `testing/wiki-projects.ts`).
 *
 * The planners compile their candidate tree and refuse one that does not reproduce the desired
 * resources (`round-trip-mismatch`), so a writer that changes meaning shows as a refusal here.
 * What they do not check is checked here: that legitimate edits plan under the authority the
 * documentation names, that the bytes an edit does not concern stay as written, that applying
 * the changes reproduces the candidate, and that planning again changes nothing.
 *
 * CI runs a fixed seed. `vp run fuzz` explores, as for the content properties.
 */
import { posix } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { Wiki, WikiNavNode } from "@topik/schema/wiki/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { Course } from "@topik/schema/course/v1";
import type { CourseModule } from "@topik/schema/course-module/v1";
import type { CoursePage } from "@topik/schema/course-page/v1";
import type { Person } from "@topik/schema/person/v1";
import type { Resource } from "../resource.js";
import {
  collectionConfigPath,
  configPath,
  courseConfigPath,
  pages,
  PNG_ADDED,
  renderSourceProject,
  renderWikiProject,
  sourceProject,
  wikiProject,
  type SourceProjectModel,
} from "../testing/source-projects.js";
import type { CourseReferenceContext } from "../course-navigation.js";
import { sourceCourseContext } from "./course.js";
import { generateAutomaticAssetName, parseAssetBlobUri } from "../assets/asset.js";
import { initializeSourceProject, type SourceMediaSelection } from "./initialize.js";
import { sourceMediaPath } from "./plan-markdown.js";
import { sourceHash } from "./syntax.js";
import {
  planSourceUpdates,
  type SourceResourceOperation,
  type SourceUpdatePlan,
  type SourceWriteAuthority,
} from "./plan.js";
import {
  digestSourceTree,
  readSourceProject,
  type SourceProject,
  type SourceTreeFile,
} from "./project.js";

const EXPLORE = process.env.TOPIK_FUZZ === "1";
const integer = (value: string | undefined) =>
  value !== undefined && /^-?\d+$/u.test(value.trim()) ? Number(value) : undefined;
const SEED = EXPLORE
  ? (integer(process.env.TOPIK_FUZZ_SEED) ?? Math.floor(Math.random() * 2 ** 31))
  : 20_261_122;
if (EXPLORE) console.info(`fuzz seed ${SEED}`);
const runs = (ci: number) => (EXPLORE ? (integer(process.env.TOPIK_FUZZ_RUNS) ?? ci * 20) : ci);
const parameters = (ci: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns: runs(ci) });
const timeout = (ci: number) => (EXPLORE ? 0 : ci);

const COHORT = "a".repeat(64);
const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);

type Edit =
  | { kind: "retitle"; page: number; title: string }
  | { kind: "describe"; page: number; description: string | null }
  | { kind: "body"; page: number }
  | { kind: "wiki-title"; title: string }
  | { kind: "reorder"; list: number }
  | { kind: "add"; list: number; title: string }
  | { kind: "delete"; page: number }
  | { kind: "move"; page: number }
  | { kind: "guide-add"; slug: string; title: string }
  | { kind: "tags"; page: number; tags: string[] | null }
  | { kind: "course-meta"; target: number; title: string }
  | { kind: "course-reorder"; list: number }
  | { kind: "course-page-add"; module: number; title: string }
  | { kind: "module-add"; title: string }
  | { kind: "page-module"; page: number; module: number }
  | { kind: "page-slug"; page: number }
  | { kind: "person-rename"; person: number; name: string }
  | { kind: "person-add"; name: string }
  | { kind: "person-delete"; person: number }
  | { kind: "authors"; page: number; persons: number[] }
  | { kind: "image-add"; page: number }
  | { kind: "media-add"; page: number };

const TITLES = ["Renamed", "Overview: part 2", "Notes #3"] as const;
// Weighted toward the edits whose preservation rules have the most to check.
const EDITS: fc.WeightedArbitrary<Edit>[] = [
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("retitle" as const),
      page: fc.nat(),
      title: fc.constantFrom(...TITLES),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("describe" as const),
      page: fc.nat(),
      description: fc.option<string>(fc.constantFrom<string>("Updated summary.", "Notes: new")),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("body" as const), page: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("wiki-title" as const),
      title: fc.constantFrom(...TITLES),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reorder" as const), list: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("add" as const),
      list: fc.nat(),
      title: fc.constantFrom(...TITLES),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("delete" as const), page: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("move" as const), page: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("guide-add" as const),
      slug: fc.constantFrom("extra", "news"),
      title: fc.constantFrom(...TITLES),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("tags" as const),
      page: fc.nat(),
      tags: fc.option<string[]>(fc.constantFrom<string[]>(["setup"], ["news", "basics"])),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("course-meta" as const),
      target: fc.nat(),
      title: fc.constantFrom(...TITLES),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("course-reorder" as const), list: fc.nat() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("course-page-add" as const),
      module: fc.nat(),
      title: fc.constantFrom(...TITLES),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("module-add" as const),
      title: fc.constantFrom(...TITLES),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("page-module" as const),
      page: fc.nat(),
      module: fc.nat(),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("page-slug" as const), page: fc.nat() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("person-rename" as const),
      person: fc.nat(),
      name: fc.constantFrom("Ada King", "Dr. Grace Hopper"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("person-add" as const),
      name: fc.constantFrom("Katherine Johnson", "Edsger Dijkstra"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("person-delete" as const), person: fc.nat() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("authors" as const),
      page: fc.nat(),
      persons: fc.uniqueArray(fc.nat(3), { maxLength: 2 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("image-add" as const), page: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("media-add" as const), page: fc.nat() }) },
];

const GUIDE_EDITS = new Set<Edit["kind"]>([
  "guide-add",
  "tags",
  "person-rename",
  "person-add",
  "person-delete",
  "authors",
]);
const COURSE_EDITS = new Set<Edit["kind"]>([
  "course-meta",
  "course-reorder",
  "course-page-add",
  "module-add",
  "page-module",
  "page-slug",
]);
/** Edits of the kinds that apply to a project's sources. */
const editsFor = (model: SourceProjectModel) =>
  fc.array(
    fc.oneof(
      ...EDITS.filter(({ arbitrary }) => {
        const [kind] = fc.sample(arbitrary, 1).map((edit) => edit.kind);
        return (
          (model.collection || !GUIDE_EDITS.has(kind)) && (model.course || !COURSE_EDITS.has(kind))
        );
      }),
    ),
    { minLength: 1, maxLength: 3 },
  );

/** A planned edit: the desired graph, its operations and the authority the docs name for it. */
interface Request {
  desired: Resource[];
  operations: SourceResourceOperation[];
  authority: SourceWriteAuthority;
  referenceContexts?: Record<string, Wiki>;
  /** New media an edit writes, with its exact bytes. */
  media?: (SourceMediaSelection & { config: string })[];
  /** Saved Course contexts beyond the project's own, such as a new page's. */
  courseReferenceContexts?: Record<string, CourseReferenceContext>;
  /** What the edit concerns, for the preservation checks. */
  concerns: {
    document?: string;
    part?: "metadata" | "body";
    /** A single value's line, or a list key whose preceding lines stay. */
    config?: "title" | "navigation" | "modules" | "persons";
  };
}

const key = (resource: Resource) => `${resource.type}/${resource.name}`;
const wikiOf = (resources: readonly Resource[]) =>
  resources.find((resource): resource is Wiki => resource.type === "Wiki")!;
const pagesOf = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is WikiPage => resource.type === "WikiPage")
    .sort((a, b) => a.name.localeCompare(b.name));
const guidesOf = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is Guide => resource.type === "Guide")
    .sort((a, b) => a.name.localeCompare(b.name));
const coursePagesOf = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is CoursePage => resource.type === "CoursePage")
    .sort((a, b) => a.name.localeCompare(b.name));
const modulesOf = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is CourseModule => resource.type === "CourseModule")
    .sort((a, b) => a.name.localeCompare(b.name));
type Document = WikiPage | Guide | CoursePage;
/** The Markdown documents of a project: Wiki pages, guides, then Course pages. */
const documentsOf = (resources: readonly Resource[]): Document[] => [
  ...pagesOf(resources),
  ...guidesOf(resources),
  ...coursePagesOf(resources),
];
const REFERENCE_KINDS = { WikiPage: "wiki-page", Guide: "guide", CoursePage: "course-page" };
const reference = (document: Document) =>
  `ref://${REFERENCE_KINDS[document.type]}/${document.name}`;
/** Whether another document links to this one. */
const linkedFrom = (documents: readonly Document[], target: Document) =>
  documents.some(
    (other) => other !== target && other.spec.content.value.includes(reference(target)),
  );

const documentOf = (project: SourceProject, resource: string) =>
  project.documents.find((document) => document.resource === resource)!;
const exclusive = (project: SourceProject, ...resources: string[]) =>
  resources.map((resource) => {
    const { path, sha256, mode } = documentOf(project, resource);
    return { path, sha256, mode };
  });
const shared = (project: SourceProject, path: string, ...selectors: string[]) => {
  const config = project.configurations.find((configuration) => configuration.path === path)!;
  return {
    ...config,
    fields: config.fields.filter((field) => selectors.includes(field.selector)),
  };
};
/** Everything the inspected project has: for edits whose derived repairs reach any file. */
const everything = (project: SourceProject, create: string[] = []): SourceWriteAuthority => ({
  resources: project.compilation.resources.map(key),
  exclusive: project.documents
    .filter((document) => /\.mdx?$/u.test(document.path))
    .map(({ path, sha256, mode }) => ({ path, sha256, mode })),
  shared: project.configurations.filter((configuration) => configuration.path !== ".topik.yaml"),
  create,
});

/** Each navigation list with the source directory its entries' files live in. */
function lists(navigation: WikiNavNode[], dir = ""): { list: WikiNavNode[]; dir: string }[] {
  const result = [{ list: navigation, dir }];
  for (const node of navigation)
    if (node.type === "group")
      result.push(...lists(node.children, node.slug ? posix.join(dir, node.slug) : dir));
  return result;
}

/** The request for one edit, or undefined when the edit does not apply to this project. */
function request(
  project: SourceProject,
  model: SourceProjectModel,
  change: Edit,
): Request | undefined {
  const config = configPath(model.wiki);
  const courseConfig = model.course ? courseConfigPath(model.course) : undefined;
  const desired = structuredClone(project.compilation.resources) as Resource[];
  const wiki = wikiOf(desired);
  const pages = pagesOf(desired);
  const documents = documentsOf(desired);
  const page =
    "page" in change && change.kind !== "tags"
      ? documents[change.page % documents.length]
      : undefined;
  const none = { resources: [], exclusive: [], shared: [], create: [] };
  switch (change.kind) {
    case "retitle":
    case "describe": {
      if (change.kind === "retitle") page!.spec.title = change.title;
      else if (change.description === null) delete page!.spec.description;
      else page!.spec.description = change.description;
      return {
        desired,
        operations: [{ kind: "update", resource: key(page!) }],
        authority: { ...none, resources: [key(page!)], exclusive: exclusive(project, key(page!)) },
        concerns: { document: key(page!), part: "metadata" },
      };
    }
    case "body": {
      const value = page!.spec.content.value;
      page!.spec.content.value = `${value.endsWith("\n") ? value : `${value}\n`}\nAdded text.\n`;
      return {
        desired,
        operations: [{ kind: "update", resource: key(page!) }],
        authority: { ...none, resources: [key(page!)], exclusive: exclusive(project, key(page!)) },
        concerns: { document: key(page!), part: "body" },
      };
    }
    case "wiki-title":
      wiki.spec.title = change.title;
      return {
        desired,
        operations: [{ kind: "update", resource: key(wiki) }],
        authority: { ...none, resources: [key(wiki)], shared: [shared(project, config, "title")] },
        concerns: { config: "title" },
      };
    case "reorder": {
      const candidates = lists(wiki.spec.navigation ?? []).filter(({ list }) => list.length > 1);
      if (!candidates.length) return undefined;
      const { list } = candidates[change.list % candidates.length];
      list.push(list.shift()!);
      return {
        desired,
        operations: [{ kind: "update", resource: key(wiki) }],
        authority: {
          ...none,
          resources: [key(wiki)],
          shared: [shared(project, config, "navigation")],
        },
        concerns: { config: "navigation" },
      };
    }
    case "add": {
      const candidates = lists(wiki.spec.navigation ?? []);
      const { list, dir } = candidates[change.list % candidates.length];
      const taken = new Set(project.tree.map((file) => file.path));
      let n = 1;
      const path = (slug: string) => posix.join(posix.dirname(config), dir, `${slug}.md`);
      while (taken.has(path(`added${n}`)) || pages.some((other) => other.name === `added-${n}`))
        n++;
      const slug = `added${n}`;
      const added = {
        ...structuredClone(pages[0]),
        name: `added-${n}`,
        spec: {
          wiki: wiki.name,
          title: change.title,
          content: { format: "topik", value: `# ${change.title}\n\nNew page.\n` },
        },
      } as WikiPage;
      list.push({ type: "page", page: added.name, slug });
      desired.push(added);
      return {
        desired,
        operations: [
          { kind: "create", resource: key(added), config, path: path(slug) },
          { kind: "update", resource: key(wiki) },
        ],
        authority: {
          ...none,
          resources: [key(added), key(wiki)],
          shared: [shared(project, config, "navigation")],
          create: [path(slug)],
        },
        referenceContexts: { [key(added)]: wiki },
        concerns: { config: "navigation" },
      };
    }
    case "delete": {
      // Deleting a document another one links to is refused; such documents are not deleted.
      const deletable = documents.filter(
        (candidate) =>
          !linkedFrom(documents, candidate) && (candidate.type !== "WikiPage" || pages.length > 1),
      );
      if (!deletable.length) return undefined;
      const target = deletable[change.page % deletable.length];
      desired.splice(desired.indexOf(target), 1);
      // An Asset whose last reference goes leaves the graph; its file stays.
      for (const asset of desired.filter((resource) => resource.type === "Asset"))
        if (
          !documentsOf(desired).some((other) =>
            other.spec.content.value.includes(`asset:${asset.name}`),
          )
        )
          desired.splice(desired.indexOf(asset), 1);
      if (target.type === "CoursePage") {
        const module = modulesOf(desired).find((entry) => entry.name === target.spec.module)!;
        module.spec.pages = module.spec.pages.filter((name) => name !== target.name);
        return {
          desired,
          operations: [
            { kind: "delete", resource: key(target) },
            { kind: "update", resource: key(module) },
          ],
          authority: {
            ...none,
            resources: [key(target), key(module)],
            exclusive: exclusive(project, key(target)),
            shared: [shared(project, courseConfig!, `modules/${module.name}/pages`)],
          },
          concerns: { config: "modules" },
        };
      }
      if (target.type === "Guide")
        return {
          desired,
          operations: [{ kind: "delete", resource: key(target) }],
          authority: {
            ...none,
            resources: [key(target)],
            exclusive: exclusive(project, key(target)),
          },
          concerns: {},
        };
      const holder = lists(wiki.spec.navigation ?? []).find(({ list }) =>
        list.some((node) => node.type === "page" && node.page === target.name),
      )!.list;
      // A group must keep an entry; a deletion that would empty one is not generated.
      if (holder.length < 2 && holder !== wiki.spec.navigation) return undefined;
      holder.splice(
        holder.findIndex((node) => node.type === "page" && node.page === target.name),
        1,
      );
      return {
        desired,
        operations: [
          { kind: "delete", resource: key(target) },
          { kind: "update", resource: key(wiki) },
        ],
        authority: {
          ...none,
          resources: [key(target), key(wiki)],
          exclusive: exclusive(project, key(target)),
          shared: [shared(project, config, "navigation")],
        },
        concerns: { config: "navigation" },
      };
    }
    case "move": {
      const document = documentOf(project, key(page!));
      // A Wiki or Course page moves to a new folder; a guide is renamed beside its collection.
      const target =
        page!.type === "Guide"
          ? document.path.replace(/(\.mdx?)$/u, "-moved$1")
          : posix.join(posix.dirname(document.path), "moved", posix.basename(document.path));
      if (project.tree.some((file) => file.path === target)) return undefined;
      return {
        desired,
        operations: [{ kind: "move", resource: key(page!), path: target }],
        // A move repairs navigation and incoming links, so its authority reaches every file.
        authority: everything(project, [target]),
        concerns: {},
      };
    }
    case "tags": {
      const guides = guidesOf(desired);
      if (!guides.length) return undefined;
      const guide = guides[change.page % guides.length];
      if (change.tags === null) delete guide.spec.tags;
      else guide.spec.tags = change.tags;
      return {
        desired,
        operations: [{ kind: "update", resource: key(guide) }],
        authority: { ...none, resources: [key(guide)], exclusive: exclusive(project, key(guide)) },
        concerns: { document: key(guide), part: "metadata" },
      };
    }
    case "guide-add": {
      const guides = guidesOf(desired);
      if (!model.collection || !guides.length) return undefined;
      const collection = collectionConfigPath(model.collection);
      const path = posix.join(model.collection.dir, `${change.slug}.md`);
      const name = `${model.collection.id}-${change.slug}`;
      if (
        project.tree.some((file) => file.path === path) ||
        desired.some((other) => other.name === name)
      )
        return undefined;
      const added = {
        ...structuredClone(guides[0]),
        name,
        spec: {
          title: change.title,
          slug: change.slug,
          content: { format: "topik", value: `# ${change.title}\n\nNew guide.\n` },
        },
      } as Guide;
      desired.push(added);
      return {
        desired,
        operations: [{ kind: "create", resource: key(added), config: collection, path }],
        authority: { ...none, resources: [key(added)], create: [path] },
        concerns: {},
      };
    }
    case "image-add": {
      // Show an image the project already has on a page that does not show it yet.
      const asset = desired.find((resource) => resource.type === "Asset");
      const without = pages.filter(
        (other) => !other.spec.content.value.includes(`asset:${asset?.name}`),
      );
      if (!asset || !without.length) return undefined;
      const target = without[change.page % without.length];
      target.spec.content.value = `${target.spec.content.value.replace(/\n*$/u, "\n")}\n![Diagram again](asset:${asset.name})\n`;
      return {
        desired,
        operations: [{ kind: "update", resource: key(target) }],
        authority: {
          ...none,
          resources: [key(target)],
          exclusive: exclusive(project, key(target)),
        },
        concerns: { document: key(target), part: "body" },
      };
    }
    case "media-add": {
      // New media goes into the configuration's asset directory with its exact bytes.
      const target = pages[change.page % pages.length];
      const assetDirectory = project.compilation.provenance.find(
        (source) => source.config === config,
      )!.assetDirectory;
      const name = generateAutomaticAssetName({
        projectNamespace: project.manifest.namespace,
        manifestRelativePath: posix.join(assetDirectory, "added.png"),
      }).value!;
      const path = sourceMediaPath({ assetDirectory, filename: "added.png", name });
      if (
        desired.some((resource) => resource.name === name) ||
        project.tree.some((file) => file.path === path)
      )
        return undefined;
      const sha256 = sourceHash(PNG_ADDED);
      desired.push({
        apiVersion: "v1",
        type: "Asset",
        name,
        spec: {
          uri: parseAssetBlobUri(`blobs/${sha256}`),
          integrity: `sha256:${sha256}`,
          size: PNG_ADDED.length,
          mediaType: "image/png",
        },
      } as Resource);
      target.spec.content.value = `${target.spec.content.value.replace(/\n*$/u, "\n")}\n![Added image](asset:${name})\n`;
      return {
        desired,
        operations: [{ kind: "update", resource: key(target) }],
        authority: {
          ...none,
          resources: [key(target)],
          exclusive: exclusive(project, key(target)),
          create: [path],
        },
        media: [{ name, filename: "added.png", sha256, bytes: PNG_ADDED, config }],
        concerns: { document: key(target), part: "body" },
      };
    }
    case "person-rename":
    case "person-add":
    case "person-delete":
    case "authors":
      return personRequest(project, model, desired, change);
    default:
      return courseRequest(project, courseConfig, desired, change);
  }
}

/** Requests for the Person edits: records in the collection, and guide authors. */
function personRequest(
  project: SourceProject,
  model: SourceProjectModel,
  desired: Resource[],
  change: Edit,
): Request | undefined {
  if (!model.collection) return undefined;
  const config = collectionConfigPath(model.collection);
  const persons = desired
    .filter((resource): resource is Person => resource.type === "Person")
    .sort((a, b) => a.name.localeCompare(b.name));
  const guides = guidesOf(desired);
  const none = { resources: [], exclusive: [], shared: [], create: [] };
  const authored = (person: Person) =>
    guides.filter((guide) => guide.spec.authors?.includes(person.name));
  switch (change.kind) {
    case "person-rename": {
      if (!persons.length) return undefined;
      const person = persons[change.person % persons.length];
      person.spec.name = change.name;
      // A shared Person change affects every guide that lists it, so they are admitted too.
      return {
        desired,
        operations: [{ kind: "update", resource: key(person) }],
        authority: {
          ...none,
          resources: [key(person), ...authored(person).map(key)],
          shared: [shared(project, config, `persons/${person.name}`)],
        },
        concerns: { config: "persons" },
      };
    }
    case "person-add": {
      if (!persons.length) return undefined;
      let n = 1;
      while (desired.some((resource) => resource.name === `author${n}`)) n++;
      const added = {
        ...structuredClone(persons[0]),
        name: `author${n}`,
        spec: { name: change.name },
      } as Person;
      desired.push(added);
      return {
        desired,
        operations: [{ kind: "create", resource: key(added), config }],
        authority: {
          ...none,
          resources: [key(added)],
          shared: [shared(project, config, "persons")],
        },
        concerns: { config: "persons" },
      };
    }
    case "person-delete": {
      // A Person a guide still lists cannot be deleted; such persons are not deleted here.
      const free = persons.filter((person) => !authored(person).length);
      if (!free.length) return undefined;
      const person = free[change.person % free.length];
      desired.splice(desired.indexOf(person), 1);
      return {
        desired,
        operations: [{ kind: "delete", resource: key(person) }],
        authority: {
          ...none,
          resources: [key(person)],
          shared: [shared(project, config, "persons")],
        },
        concerns: { config: "persons" },
      };
    }
    case "authors": {
      if (!guides.length || !persons.length) return undefined;
      const guide = guides[change.page % guides.length];
      const authors = change.persons.map((index) => persons[index % persons.length].name);
      if (authors.length) guide.spec.authors = [...new Set(authors)];
      else delete guide.spec.authors;
      return {
        desired,
        operations: [{ kind: "update", resource: key(guide) }],
        authority: { ...none, resources: [key(guide)], exclusive: exclusive(project, key(guide)) },
        concerns: { document: key(guide), part: "metadata" },
      };
    }
    default:
      return undefined;
  }
}

/** Requests for the Course edits. */
function courseRequest(
  project: SourceProject,
  config: string | undefined,
  desired: Resource[],
  change: Edit,
): Request | undefined {
  const course = desired.find((resource): resource is Course => resource.type === "Course");
  if (!config || !course) return undefined;
  const modules = modulesOf(desired);
  const pages = coursePagesOf(desired);
  const documents = documentsOf(desired);
  const none = { resources: [], exclusive: [], shared: [], create: [] };
  const moduleOf = (name: string) => modules.find((module) => module.name === name)!;
  switch (change.kind) {
    case "course-meta": {
      const target = change.target % (modules.length + 1);
      const resource = target === 0 ? course : modules[target - 1];
      resource.spec.title = change.title;
      return {
        desired,
        operations: [{ kind: "update", resource: key(resource) }],
        authority: {
          ...none,
          resources: [key(resource)],
          shared: [
            shared(project, config, target === 0 ? "title" : `modules/${resource.name}/title`),
          ],
        },
        concerns: { config: "title" },
      };
    }
    case "course-reorder": {
      const lists = [
        { resource: course as Course | CourseModule, list: course.spec.modules, field: "modules" },
        ...modules.map((module) => ({
          resource: module as Course | CourseModule,
          list: module.spec.pages,
          field: `modules/${module.name}/pages`,
        })),
      ].filter(({ list }) => list.length > 1);
      if (!lists.length) return undefined;
      const { resource, list, field } = lists[change.list % lists.length];
      list.push(list.shift()!);
      return {
        desired,
        operations: [{ kind: "update", resource: key(resource) }],
        authority: {
          ...none,
          resources: [key(resource)],
          shared: [shared(project, config, field)],
        },
        concerns: { config: "modules" },
      };
    }
    case "course-page-add": {
      if (!pages.length) return undefined;
      const module = modules[change.module % modules.length];
      let n = 1;
      const name = () => `${module.name}-added${n}`;
      const path = () => posix.join(posix.dirname(config), "lessons", `${name()}.md`);
      while (
        desired.some((resource) => resource.name === name()) ||
        project.tree.some((file) => file.path === path())
      )
        n++;
      const added = {
        ...structuredClone(pages[0]),
        name: name(),
        spec: {
          module: module.name,
          title: change.title,
          slug: `added${n}`,
          content: { format: "topik", value: `# ${change.title}\n\nNew lesson.\n` },
        },
      } as CoursePage;
      desired.push(added);
      module.spec.pages.push(added.name);
      // A new page is saved against a context that already lists it.
      const paths = new Map(
        project.documents.map((document) => [document.resource, document.path]),
      );
      paths.set(key(added), path());
      const context = sourceCourseContext(desired, course, paths, posix.dirname(config));
      return {
        desired,
        operations: [
          { kind: "create", resource: key(added), config, path: path() },
          { kind: "update", resource: key(module) },
        ],
        authority: {
          ...none,
          resources: [key(added), key(module)],
          shared: [shared(project, config, `modules/${module.name}/pages`)],
          create: [path()],
        },
        courseReferenceContexts: { [key(added)]: context },
        concerns: { config: "modules" },
      };
    }
    case "module-add": {
      let n = 1;
      while (desired.some((resource) => resource.name === `bonus${n}`)) n++;
      const added = {
        ...structuredClone(modules[0]),
        name: `bonus${n}`,
        spec: { course: course.name, title: change.title, slug: `bonus${n}`, pages: [] },
      } as CourseModule;
      desired.push(added);
      course.spec.modules.push(added.name);
      return {
        desired,
        operations: [
          { kind: "create", resource: key(added), config },
          { kind: "update", resource: key(course) },
        ],
        authority: {
          ...none,
          resources: [key(added), key(course)],
          shared: [shared(project, config, "modules")],
        },
        concerns: { config: "modules" },
      };
    }
    case "page-module":
    case "page-slug": {
      if (!pages.length) return undefined;
      const page = pages[change.page % pages.length];
      const operations: SourceResourceOperation[] = [{ kind: "update", resource: key(page) }];
      const fields: string[] = [];
      if (change.kind === "page-slug") page.spec.slug = `${page.spec.slug}-v2`;
      else {
        const from = moduleOf(page.spec.module);
        const to = modules[change.module % modules.length];
        // Routes must stay unique: a page does not join a module with a page of its slug.
        if (
          to === from ||
          pages.some((other) => other.spec.module === to.name && other.spec.slug === page.spec.slug)
        )
          return undefined;
        from.spec.pages = from.spec.pages.filter((name) => name !== page.name);
        to.spec.pages.push(page.name);
        page.spec.module = to.name;
        operations.push(
          { kind: "update", resource: key(from) },
          { kind: "update", resource: key(to) },
        );
        fields.push(`modules/${from.name}/pages`, `modules/${to.name}/pages`);
      }
      // A new route repairs the links to the page, so then the authority reaches every file.
      return {
        desired,
        operations,
        authority: linkedFrom(documents, page)
          ? everything(project)
          : {
              ...none,
              resources: operations.map((operation) => operation.resource),
              exclusive: exclusive(project, key(page)),
              shared: fields.length ? [shared(project, config, ...fields)] : [],
            },
        // A page's links to its own old route are repaired in its body.
        concerns: fields.length
          ? { config: "modules" }
          : page.spec.content.value.includes(reference(page))
            ? {}
            : { document: key(page), part: "metadata" },
      };
    }
    default:
      return undefined;
  }
}

/** Apply a plan's changes to a tree, as a coordinator would. */
function apply(tree: readonly SourceTreeFile[], plan: SourceUpdatePlan): SourceTreeFile[] {
  const files = new Map(tree.map((file) => [file.path, file]));
  for (const change of plan.changes)
    if (change.kind === "delete") files.delete(change.path);
    else
      files.set(change.path, {
        path: change.path,
        mode: change.candidate!.mode,
        bytes: change.candidate!.bytes,
      });
  return [...files.values()];
}

const slice = (bytes: Uint8Array, range?: { start: number; end: number }) =>
  range ? text(bytes.subarray(range.start, range.end)) : "";
const lines = (value: string) => value.split(/\r?\n/u);
const crlf = (value: string) => value.includes("\r\n");
const bareLf = (value: string) => /(?<!\r)\n/u.test(value);

/** Keys a metadata edit may change; `inheritTags` is written with tags, `slug` by a route edit. */
const EDITED_KEYS = /^(title|description|tags|inheritTags|slug|authors):/u;

/**
 * The frontmatter lines outside the keys a metadata edit may change: comments and other keys.
 * An indented line belongs to the key above it, such as a block list item or a value written
 * on its own line.
 */
function unchangedLines(frontmatter: string): string[] {
  let edited = false;
  return lines(frontmatter).filter((line) => {
    if (!line.trim()) return false;
    if (!/^\s/u.test(line)) edited = EDITED_KEYS.test(line);
    return !edited;
  });
}

/** The bytes an edit does not concern must stay as written. */
function checkPreservation(
  before: SourceProject,
  after: SourceProject,
  request: Request,
  plan: SourceUpdatePlan,
) {
  for (const change of plan.changes) {
    if (change.kind !== "update") continue;
    const base = before.tree.find((file) => file.path === change.path)!;
    const old = text(base.bytes);
    const now = text(change.candidate!.bytes);
    expect({ path: change.path, mode: change.candidate!.mode }).toEqual({
      path: change.path,
      mode: base.mode,
    });
    expect({ path: change.path, bom: now.startsWith("﻿") }).toEqual({
      path: change.path,
      bom: old.startsWith("﻿"),
    });
    if (crlf(old) && !bareLf(old))
      expect({ path: change.path, bareLf: bareLf(now) }).toEqual({
        path: change.path,
        bareLf: false,
      });
  }
  const { document, part, config } = request.concerns;
  if (document) {
    const was = documentOf(before, document);
    const is = documentOf(after, document);
    const old = before.tree.find((file) => file.path === was.path)!.bytes;
    const now = after.tree.find((file) => file.path === is.path)!.bytes;
    if (part === "metadata") {
      expect(slice(now, is.body)).toBe(slice(old, was.body));
      // Comments and keys the edit does not change keep their lines, in order.
      const kept = unchangedLines(slice(old, was.frontmatter));
      const written = lines(slice(now, is.frontmatter));
      expect(written.filter((line) => kept.includes(line))).toEqual(kept);
    } else if (part === "body") {
      expect(slice(now, is.frontmatter)).toBe(slice(old, was.frontmatter));
    }
  }
  if (config) {
    const path = request.authority.shared[0].path;
    const old = text(before.tree.find((file) => file.path === path)!.bytes);
    const now = text(after.tree.find((file) => file.path === path)!.bytes);
    if (config === "title") {
      // Only the title's value changes; every other line, comments included, stays.
      const changed = lines(old)
        .map((line, index) => [line, lines(now)[index]] as const)
        .filter(([was, is]) => was !== is);
      expect({ lines: lines(now).length, changed: changed.length }).toEqual({
        lines: lines(old).length,
        changed: changed.length && 1,
      });
    } else {
      // List edits keep everything before the list's key.
      const head = (value: string) =>
        value.slice(0, value.search(new RegExp(`^\\s*"?${config}"?:`, "mu")));
      expect(head(now)).toBe(head(old));
    }
  }
}

/**
 * The project a generated model renders, or undefined when it does not compile. Generated page
 * documents can break rules a project enforces, such as unique heading ids.
 */
async function compiled(tree: SourceTreeFile[]) {
  try {
    return await readSourceProject({ tree });
  } catch {
    return undefined;
  }
}

async function plan(project: SourceProject, request: Request) {
  return planSourceUpdates({
    project,
    expectedTreeDigest: project.treeDigest,
    packageCohort: COHORT,
    desiredResources: request.desired,
    operations: request.operations,
    authority: request.authority,
    ...(request.referenceContexts ? { referenceContexts: request.referenceContexts } : {}),
    ...(request.media ? { media: request.media } : {}),
    courseReferenceContexts: {
      ...courseContexts(project, request.desired),
      ...request.courseReferenceContexts,
    },
  });
}

/** The saved Course context of every Course page, as an editor keeps it with saved content. */
function courseContexts(project: SourceProject, desired: readonly Resource[]) {
  const modules = new Map(
    desired
      .filter((resource): resource is CourseModule => resource.type === "CourseModule")
      .map((module) => [module.name, module.spec.course]),
  );
  return Object.fromEntries(
    coursePagesOf(desired).flatMap((page) => {
      const context = project.courseContexts[`Course/${modules.get(page.spec.module)}`];
      return context ? [[key(page), context]] : [];
    }),
  );
}

/** Planning a project's own resources again must change nothing. */
async function expectIdempotent(project: SourceProject) {
  const again = await plan(project, {
    desired: structuredClone(project.compilation.resources) as Resource[],
    operations: [],
    authority: { resources: [], exclusive: [], shared: [], create: [] },
    concerns: {},
  });
  expect(again.ok ? again.plan.changes.map((change) => change.path) : again.diagnostics).toEqual(
    [],
  );
}

/**
 * Plan one edit and check it: it plans under its documented authority, applying its changes
 * reproduces the candidate, the bytes it does not concern stay, and planning again changes
 * nothing. Returns the candidate, or undefined when the edit does not apply to the project.
 */
async function planAndCheck(project: SourceProject, model: SourceProjectModel, change: Edit) {
  const next = request(project, model, change);
  if (!next) return undefined;
  const result = await plan(project, next);
  expect({ edit: change, diagnostics: result.ok ? [] : result.diagnostics }).toEqual({
    edit: change,
    diagnostics: [],
  });
  if (!result.ok) return undefined;
  const applied = apply(project.tree, result.plan);
  expect(digestSourceTree(applied)).toBe(result.plan.candidateTreeDigest);
  checkPreservation(project, result.plan.candidate, next, result.plan);
  await expectIdempotent(result.plan.candidate);
  return result.plan.candidate;
}

/** A project with every kind of source, enough Wiki pages and more than one Course module. */
const complete = sourceProject.filter(
  (model) =>
    model.collection !== null &&
    model.collection.persons.length > 1 &&
    model.course !== null &&
    model.course.modules.length > 1 &&
    pages(model.wiki).length > 1 &&
    pages(model.wiki).some(({ page }) => page.image),
);

/** Compiled complete projects, generated once and shared by the per-kind tests. */
let completeSample: Promise<{ model: SourceProjectModel; project: SourceProject }[]> | undefined;
const completeProjects = () =>
  (completeSample ??= (async () => {
    const result = [];
    for (const model of fc.sample(complete, { seed: SEED, numRuns: 30 })) {
      const project = await compiled(renderSourceProject(model));
      if (project) result.push({ model, project });
    }
    return result;
  })());

describe("source write-back", () => {
  // The random property below need not draw every kind of edit; this checks each one.
  test.each(EDITS.map(({ arbitrary }) => fc.sample(arbitrary, { seed: SEED, numRuns: 1 })[0]))(
    "a $kind edit plans and keeps unrelated bytes on a generated project",
    async (change) => {
      for (const { model, project } of await completeProjects())
        if (await planAndCheck(project, model, change)) return;
      throw new Error(`No generated project admits the edit ${JSON.stringify(change)}`);
    },
    timeout(60_000),
  );

  test(
    "edits plan under their documented authority, keep unrelated bytes and replan to nothing",
    async () => {
      let planned = 0;
      let projects = 0;
      await fc.assert(
        fc.asyncProperty(
          sourceProject.chain((model) => fc.tuple(fc.constant(model), editsFor(model))),
          async ([model, edits]) => {
            const inspected = await compiled(renderSourceProject(model));
            if (!inspected) return;
            projects++;
            let project = inspected;
            await expectIdempotent(project);
            for (const change of edits) {
              const candidate = await planAndCheck(project, model, change);
              if (!candidate) continue;
              planned++;
              project = candidate;
            }
          },
        ),
        parameters(30),
      );
      // Keep the generator honest: half the projects must compile and most edits must plan.
      expect(projects).toBeGreaterThanOrEqual(runs(30) * 0.5);
      expect(planned).toBeGreaterThan(projects);
    },
    timeout(120_000),
  );

  test(
    "initializing a project from its compiled resources succeeds and replans to nothing",
    async () => {
      await fc.assert(
        fc.asyncProperty(wikiProject, async (model) => {
          const inspected = await compiled(renderWikiProject(model));
          if (!inspected) return;
          const resources = inspected.compilation.resources;
          const wiki = wikiOf(resources);
          const config = configPath(model);
          const documents = (nodes: WikiNavNode[]): string[] =>
            nodes.flatMap((node) =>
              node.type === "page"
                ? [`${posix.join(posix.dirname(config), node.sourcePath!)}.md`]
                : node.type === "group"
                  ? documents(node.children)
                  : [],
            );
          // Initialization needs each Asset's exact bytes; they land in the new asset directory.
          const media = resources
            .filter((resource) => resource.type === "Asset")
            .map((asset) => {
              const path = inspected.compilation.assetSourcePaths[asset.name];
              const bytes = inspected.tree.find((file) => file.path === path)!.bytes;
              return {
                name: asset.name,
                filename: posix.basename(path),
                sha256: sourceHash(bytes),
                bytes,
              };
            });
          const mediaPaths = media.map(({ name, filename }) =>
            sourceMediaPath({
              assetDirectory: posix.join(posix.dirname(config), "_assets"),
              filename,
              name,
            }),
          );
          const result = await initializeSourceProject({
            tree: [],
            expectedTreeDigest: digestSourceTree([]),
            packageCohort: COHORT,
            intent: {
              namespace: "demo/fuzz",
              source: { kind: "wiki", config, id: wiki.name, title: wiki.spec.title },
            },
            resources,
            ...(media.length ? { media } : {}),
            createPaths: [
              ".topik.yaml",
              config,
              ...documents(wiki.spec.navigation ?? []),
              ...mediaPaths,
            ],
          });
          expect(result.ok ? [] : result.diagnostics).toEqual([]);
          if (result.ok) await expectIdempotent(result.plan.candidate);
        }),
        parameters(15),
      );
    },
    timeout(120_000),
  );
});
