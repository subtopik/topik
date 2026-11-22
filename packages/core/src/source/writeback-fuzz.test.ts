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
import type { Resource } from "../resource.js";
import { configPath, renderWikiProject, wikiProject } from "../testing/wiki-projects.js";
import { initializeSourceProject } from "./initialize.js";
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
  | { kind: "move"; page: number };

const TITLES = ["Renamed", "Overview: part 2", "Notes #3"] as const;
// Weighted toward the edits whose preservation rules have the most to check.
const edit: fc.Arbitrary<Edit> = fc.oneof(
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
      description: fc.option(fc.constantFrom("Updated summary.", "Notes: new")),
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
);

/** A planned edit: the desired graph, its operations and the authority the docs name for it. */
interface Request {
  desired: Resource[];
  operations: SourceResourceOperation[];
  authority: SourceWriteAuthority;
  referenceContexts?: Record<string, Wiki>;
  /** What the edit concerns, for the preservation checks. */
  concerns: { document?: string; part?: "metadata" | "body"; config?: "title" | "navigation" };
}

const key = (resource: Resource) => `${resource.type}/${resource.name}`;
const wikiOf = (resources: readonly Resource[]) =>
  resources.find((resource): resource is Wiki => resource.type === "Wiki")!;
const pagesOf = (resources: readonly Resource[]) =>
  resources
    .filter((resource): resource is WikiPage => resource.type === "WikiPage")
    .sort((a, b) => a.name.localeCompare(b.name));

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
function request(project: SourceProject, config: string, change: Edit): Request | undefined {
  const desired = structuredClone(project.compilation.resources) as Resource[];
  const wiki = wikiOf(desired);
  const pages = pagesOf(desired);
  const page = "page" in change ? pages[change.page % pages.length] : undefined;
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
      // Deleting a page that another page links to is refused; such pages are not deleted here.
      const linked = (target: WikiPage) =>
        pages.some(
          (other) =>
            other !== target && other.spec.content.value.includes(`ref://wiki-page/${target.name}`),
        );
      const deletable = pages.filter((candidate) => !linked(candidate));
      if (pages.length < 2 || !deletable.length) return undefined;
      const target = deletable[change.page % deletable.length];
      const holder = lists(wiki.spec.navigation ?? []).find(({ list }) =>
        list.some((node) => node.type === "page" && node.page === target.name),
      )!.list;
      // A group must keep an entry; a deletion that would empty one is not generated.
      if (holder.length < 2 && holder !== wiki.spec.navigation) return undefined;
      holder.splice(
        holder.findIndex((node) => node.type === "page" && node.page === target.name),
        1,
      );
      desired.splice(desired.indexOf(target), 1);
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
      const target = posix.join(posix.dirname(config), "moved", posix.basename(document.path));
      if (project.tree.some((file) => file.path === target)) return undefined;
      return {
        desired,
        operations: [{ kind: "move", resource: key(page!), path: target }],
        // A move repairs navigation and incoming links, so its authority reaches every file.
        authority: everything(project, [target]),
        concerns: {},
      };
    }
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
      const kept = lines(slice(old, was.frontmatter)).filter(
        (line) => line.trim() && !/^(title|description):/u.test(line),
      );
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
      // Navigation edits keep everything before the navigation key.
      const head = (value: string) => value.slice(0, value.search(/^\s*"?navigation"?:/mu));
      expect(head(now)).toBe(head(old));
    }
  }
}

/**
 * The project a generated model renders, or undefined when it does not compile. Generated page
 * documents can break rules a project enforces, such as unique heading ids.
 */
async function compiled(model: Parameters<typeof renderWikiProject>[0]) {
  try {
    return await readSourceProject({ tree: renderWikiProject(model) });
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
  });
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

describe("Wiki write-back", () => {
  test(
    "edits plan under their documented authority, keep unrelated bytes and replan to nothing",
    async () => {
      let planned = 0;
      let projects = 0;
      await fc.assert(
        fc.asyncProperty(
          wikiProject,
          fc.array(edit, { minLength: 1, maxLength: 3 }),
          async (model, edits) => {
            const config = configPath(model);
            const inspected = await compiled(model);
            if (!inspected) return;
            projects++;
            let project = inspected;
            await expectIdempotent(project);
            for (const change of edits) {
              const next = request(project, config, change);
              if (!next) continue;
              const result = await plan(project, next);
              expect({ edit: change, diagnostics: result.ok ? [] : result.diagnostics }).toEqual({
                edit: change,
                diagnostics: [],
              });
              if (!result.ok) return;
              planned++;
              const applied = apply(project.tree, result.plan);
              expect(digestSourceTree(applied)).toBe(result.plan.candidateTreeDigest);
              checkPreservation(project, result.plan.candidate, next, result.plan);
              project = result.plan.candidate;
              await expectIdempotent(project);
            }
          },
        ),
        parameters(40),
      );
      // Keep the generator honest: most generated edits must apply and plan.
      // Keep the generator honest: most projects must compile and most edits must plan.
      expect(projects).toBeGreaterThan(runs(40) * 0.6);
      expect(planned).toBeGreaterThan(projects);
    },
    timeout(120_000),
  );

  test(
    "initializing a project from its compiled resources succeeds and replans to nothing",
    async () => {
      await fc.assert(
        fc.asyncProperty(wikiProject, async (model) => {
          const inspected = await compiled(model);
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
          const result = await initializeSourceProject({
            tree: [],
            expectedTreeDigest: digestSourceTree([]),
            packageCohort: COHORT,
            intent: {
              namespace: "demo/fuzz",
              source: { kind: "wiki", config, id: wiki.name, title: wiki.spec.title },
            },
            resources,
            createPaths: [".topik.yaml", config, ...documents(wiki.spec.navigation ?? [])],
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
