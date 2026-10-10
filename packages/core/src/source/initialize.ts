import { posix } from "node:path";
import { rewriteTopikAssetOccurrences, rewriteTopikNavigationReferences } from "@topik/content";
import type { Resource } from "../resource";
import type { Wiki } from "@topik/schema/wiki/v1";
import type { Guide } from "@topik/schema/guide/v1";
import type { WikiPage } from "@topik/schema/wiki-page/v1";
import { resolveSourceReferenceContext } from "./reference-context";
import { sourcePlanDiagnostics, SourcePlanningError } from "./diagnostics";
import {
  applySourceAssetReferenceContexts,
  type SourceAssetReferenceContexts,
} from "./asset-context";
import { parseTopikManifest, type TopikManifestSource } from "../config/manifest";
import { parseWikiConfig } from "../config/wiki";
import { parseCollectionConfig } from "../config/collection";
import { parseSafeConfigurationYaml } from "../compile/config";
import { validateResources } from "../validate";
import { serializeTopikJson, parseStrictTopikJson } from "../assets/json";
import { generateAutomaticAssetName } from "../assets/asset";
import { validateTopikPathSet } from "../assets/path";
import {
  resolveWikiNavigation,
  resolveWikiContentHref,
  resolveWikiContentReference,
} from "../wiki-navigation";
import {
  readSourceProject,
  digestSourceTree,
  digestSourceResourceGraph,
  snapshotSourceTree,
  SOURCE_WRITER_DESCRIPTOR,
  type SourceTreeFile,
  type SourceProject,
} from "./project";
import {
  encodeSource,
  decodeSource,
  sourceHash,
  patchSourceSequence,
  replaySourceByteEdits,
  type SourceByteEdit,
} from "./syntax";
import {
  authoredBody,
  canonicalResource,
  sourceNavigation,
  type SourcePlanResult,
  type SourceFileChange,
  type SourceUpdatePlan,
  type SourceSharedAuthority,
  verifySharedEdits,
} from "./plan";

export interface SourceInitializationIntent {
  namespace: string;
  source: TopikManifestSource & { id: string; title: string; assetDirectory?: string };
}
export interface SourceMediaSelection {
  name: string;
  filename: string;
  sha256: string;
  bytes: Uint8Array;
}
export interface InitializeSourceProjectInput {
  /** Full occupied-path inventory; missing/invalid manifests are never admitted as empty projects. */
  tree: readonly SourceTreeFile[];
  expectedTreeDigest: string;
  packageCohort: string;
  /** This explicit reviewed intent is sealed by the application before planning. */
  intent: SourceInitializationIntent;
  resources: readonly Resource[];
  media?: readonly SourceMediaSelection[];
  /** Immutable Wiki context retained with each saved page body. */
  referenceContexts?: Readonly<Record<string, Wiki>>;
  /** Explicit new Guide file paths, independently admitted in createPaths. */
  documentPaths?: Readonly<Record<string, string>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  /** Exact expected-absence paths admitted from the complete inventory. */
  createPaths: readonly string[];
}

/** Initialization is distinct from adding a source to a valid existing manifest. */
export async function initializeSourceProject(
  input: InitializeSourceProjectInput,
): Promise<SourcePlanResult> {
  return buildSource(input);
}

export interface AddSourceToProjectInput {
  project: SourceProject;
  expectedTreeDigest: string;
  packageCohort: string;
  source: SourceInitializationIntent["source"];
  resources: readonly Resource[];
  media?: readonly SourceMediaSelection[];
  referenceContexts?: Readonly<Record<string, Wiki>>;
  documentPaths?: Readonly<Record<string, string>>;
  assetReferenceContexts?: SourceAssetReferenceContexts;
  createPaths: readonly string[];
  manifestAuthority: SourceSharedAuthority;
}

/** Adding a declaration preserves the existing namespace, order and every original source. */
export async function addSourceToProject(
  input: AddSourceToProjectInput,
): Promise<SourcePlanResult> {
  try {
    if (digestSourceTree(input.project.tree) !== input.expectedTreeDigest)
      throw new TypeError("Stale source base");
    const project = await readSourceProject({ tree: input.project.tree });
    return buildSource(
      {
        tree: project.tree,
        expectedTreeDigest: input.expectedTreeDigest,
        packageCohort: input.packageCohort,
        intent: { namespace: project.manifest.namespace, source: input.source },
        resources: input.resources,
        media: input.media,
        referenceContexts: input.referenceContexts,
        assetReferenceContexts: input.assetReferenceContexts,
        documentPaths: input.documentPaths,
        createPaths: input.createPaths,
      },
      { project, authority: input.manifestAuthority },
    );
  } catch (error) {
    return {
      ok: false,
      diagnostics: sourcePlanDiagnostics(error, {
        code: "source-add-validation-failed",
        message:
          "Source addition requires a valid pinned existing project and root insertion authority.",
      }),
    };
  }
}

async function buildSource(
  input: InitializeSourceProjectInput,
  existing?: { project: SourceProject; authority: SourceSharedAuthority },
): Promise<SourcePlanResult> {
  const failure = (code: string, message: string): SourcePlanResult => ({
    ok: false,
    diagnostics: [{ code, message }],
  });
  try {
    const derivedRepairs: SourceUpdatePlan["derivedRepairs"][number][] = [];
    const occupied = snapshotSourceTree(input.tree);
    const baseTreeDigest = digestSourceTree(occupied);
    if (baseTreeDigest !== input.expectedTreeDigest)
      return failure(
        "source-base-changed",
        "Initialization requires the pinned complete destination inventory.",
      );
    if (!/^[a-f0-9]{64}$/.test(input.packageCohort))
      return failure(
        "package-cohort-required",
        "Initialization requires the verified package cohort integrity.",
      );
    if (
      input.documentPaths &&
      Object.keys(input.documentPaths).some(
        (identity) =>
          !input.resources.some(
            (resource) => resource.type === "Guide" && identity === `Guide/${resource.name}`,
          ),
      )
    )
      return failure("source-mapping-invalid", "Explicit document paths must identify new Guides.");
    if (
      !existing &&
      occupied.some(
        (file) => posix.basename(file.path) === ".topik.yaml" || file.path.endsWith(".topik.json"),
      )
    )
      return failure(
        "initialization-unproven",
        "An existing project or resource source requires inspection and an explicit source-add decision.",
      );
    for (const file of existing
      ? []
      : occupied.filter((file) => /\.(?:ya?ml|json)$/.test(file.path))) {
      // A config-like file cannot be silently ignored when proving project absence.
      const raw = decodeSource(file.bytes);
      {
        let parsed: unknown;
        try {
          parsed = file.path.endsWith(".json")
            ? parseStrictTopikJson(raw.replace(/^\uFEFF/u, ""), 32)
            : parseSafeConfigurationYaml(raw);
        } catch {
          return failure(
            "initialization-unproven",
            "Resolve an existing configuration before initializing a source project.",
          );
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const value = parsed as Record<string, unknown>;
        if (
          Object.hasOwn(value, "sourceVersion") ||
          (Object.hasOwn(value, "id") && Object.hasOwn(value, "title"))
        )
          return failure(
            "initialization-unproven",
            "Existing source configuration must be resolved before project initialization.",
          );
      }
    }
    if (
      !validateResources(input.resources).valid ||
      new Set(input.resources.map((resource) => `${resource.type}/${resource.name}`)).size !==
        input.resources.length
    )
      return failure(
        "resource-invalid",
        "Initialization requires a complete valid resource graph with unique identities.",
      );
    const { source } = input.intent;
    const manifest = parseTopikManifest({
      version: 1,
      namespace: input.intent.namespace,
      sources: [{ kind: source.kind, config: source.config }],
    });
    const directory = posix.dirname(source.config) === "." ? "" : posix.dirname(source.config);
    const assetDirectory = source.assetDirectory ?? "_assets";
    const paths = new Map<string, string>();
    const generatedFiles: SourceTreeFile[] = [];
    const add = (path: string, raw: string | Uint8Array) => {
      generatedFiles.push({
        path,
        mode: "100644",
        bytes: typeof raw === "string" ? encodeSource(raw) : new Uint8Array(raw),
      });
    };
    const expected = structuredClone([...input.resources]);
    applySourceAssetReferenceContexts(
      expected,
      input.assetReferenceContexts,
      expected.map((resource) => `${resource.type}/${resource.name}`),
    );
    const assets = new Map<string, string>();
    const assetMappings = new Map<string, string>();
    const assetResources = expected.filter((resource) => resource.type === "Asset");
    if (assetResources.length !== (input.media?.length ?? 0))
      return failure(
        "asset-bytes-required",
        "Every initialized Asset requires one exact supplied byte selection.",
      );
    for (const selection of input.media ?? []) {
      const resource = assetResources.find((asset) => asset.name === selection.name);
      if (
        !resource ||
        assetMappings.has(selection.name) ||
        sourceHash(selection.bytes) !== selection.sha256 ||
        resource.spec.integrity !== `sha256:${selection.sha256}` ||
        resource.spec.size !== selection.bytes.length
      )
        return failure(
          "asset-bytes-mismatch",
          "Asset selections must match the complete desired graph and exact digests.",
        );
      const filename = posix.basename(selection.filename);
      if (filename !== selection.filename || !validateTopikPathSet([filename]).ok)
        return failure("asset-path-invalid", "Media filenames must be portable leaf names.");
      const extension = posix.extname(filename);
      const stem = filename.slice(0, filename.length - extension.length);
      const path = posix.join(
        directory,
        assetDirectory,
        `${stem}-${sourceHash(encodeSource(selection.name)).slice(0, 8)}${extension}`,
      );
      const identity = generateAutomaticAssetName({
        projectNamespace: manifest.namespace,
        manifestRelativePath: path,
      });
      if (!identity.ok)
        return failure("asset-path-invalid", "The local media destination is invalid.");
      add(path, selection.bytes);
      assets.set(selection.name, path);
      assetMappings.set(selection.name, identity.value);
      resource.name = identity.value;
    }
    let config: Record<string, unknown>;
    if (source.kind === "collection") {
      if (input.resources.some((resource) => !["Guide", "Person", "Asset"].includes(resource.type)))
        return failure(
          "resource-unrepresentable",
          "A collection initializes Guides, Persons and their media only.",
        );
      if (
        occupied.some(
          (file) => /\.mdx?$/.test(file.path) && posix.dirname(file.path) === (directory || "."),
        )
      )
        return failure(
          "initialization-unproven",
          "A new collection cannot adopt existing Markdown by directory coincidence.",
        );
      config = {
        id: source.id,
        title: source.title,
        sourceVersion: 1,
        ...(source.assetDirectory !== undefined ? { assets: { directory: assetDirectory } } : {}),
        ...(input.resources.some((resource) => resource.type === "Person")
          ? {
              persons: input.resources
                .filter((resource) => resource.type === "Person")
                .map((person) => ({
                  id: person.name,
                  ...(person.labels !== undefined ? { labels: person.labels } : {}),
                  spec: person.spec,
                })),
            }
          : {}),
      };
      parseCollectionConfig(config);
      const allocated = new Set<string>();
      for (const guide of input.resources.filter(
        (resource): resource is Guide => resource.type === "Guide",
      )) {
        const requested =
          input.documentPaths?.[`Guide/${guide.name}`] ??
          posix.join(directory, `${guide.spec.slug}.md`);
        const path =
          !input.documentPaths?.[`Guide/${guide.name}`] && allocated.has(requested)
            ? posix.join(
                directory,
                `${guide.spec.slug}-${sourceHash(encodeSource(guide.name)).slice(0, 8)}.md`,
              )
            : requested;
        paths.set(`Guide/${guide.name}`, path);
        allocated.add(path);
      }
    } else {
      const wikis = expected.filter((resource): resource is Wiki => resource.type === "Wiki");
      if (
        wikis.length !== 1 ||
        wikis[0].name !== source.id ||
        input.resources.some((resource) => !["Wiki", "WikiPage", "Asset"].includes(resource.type))
      )
        return failure(
          "resource-unrepresentable",
          "A Wiki initializes exactly one Wiki and its pages/media.",
        );
      const wiki = wikis[0];
      const originalWiki = structuredClone(wiki);
      wiki.spec.sourceVersion = 1;
      const navigation = resolveWikiNavigation(wiki.spec.navigation ?? [], { sourceVersion: 1 });
      const pages = expected.filter(
        (resource): resource is WikiPage => resource.type === "WikiPage",
      );
      if (
        pages.length !== navigation.pages.length ||
        pages.some((page) => page.spec.wiki !== wiki.name || !navigation.pageByName.has(page.name))
      )
        return failure(
          "source-mapping-missing",
          "Every new Wiki page needs its explicit navigation/source association.",
        );
      for (const page of navigation.pages)
        paths.set(`WikiPage/${page.page}`, posix.join(directory, `${page.sourcePath}.md`));
      const transportSources = (nodes: NonNullable<Wiki["spec"]["navigation"]>) => {
        for (const node of nodes) {
          if (node.type === "page")
            node.sourcePath = posix
              .relative(directory || ".", paths.get(`WikiPage/${node.page}`)!)
              .replace(/\.md$/, "");
          else if ("children" in node) transportSources(node.children);
        }
      };
      if (wiki.spec.navigation) transportSources(wiki.spec.navigation);
      const finalNavigation = resolveWikiNavigation(wiki.spec.navigation ?? [], {
        sourceVersion: 1,
      });
      for (const page of pages) {
        const context = resolveSourceReferenceContext(
          input.referenceContexts?.[`WikiPage/${page.name}`] ?? originalWiki,
          wiki.name,
          page.name,
        );
        if (!context.ok) return failure("reference-context-invalid", context.message);
        const savedNavigation = context.navigation;
        const rewritten = rewriteTopikNavigationReferences(
          page.spec.content.value,
          (reference) => {
            const { href } = reference;
            const saved = resolveWikiContentReference(href, page.name, savedNavigation);
            if (saved.kind === "unresolved")
              throw new SourcePlanningError({
                code: "reference-target-unresolved",
                message: "An authored link has no target in its saved source context.",
                resource: `WikiPage/${page.name}`,
              });
            if (saved.kind !== "page") return undefined;
            const before = saved.target;
            const after = resolveWikiContentHref(href, page.name, finalNavigation);
            if (
              after?.page.page === before.page.page &&
              after.hash === before.hash &&
              after.search === before.search
            )
              return undefined;
            const target = finalNavigation.pageByName.get(before.page.page);
            if (!target) throw new TypeError("Saved link target is missing from the new Wiki");
            const path = `/${target.route.split("/").map(encodeURIComponent).join("/")}${before.search}${before.hash ? `#${before.hash}` : ""}`;
            const proof = resolveWikiContentHref(path, page.name, finalNavigation);
            if (
              proof?.page.page !== before.page.page ||
              proof.hash !== before.hash ||
              proof.search !== before.search
            )
              throw new TypeError("Link target cannot be preserved");
            derivedRepairs.push({
              resource: `WikiPage/${page.name}`,
              kind: "reference",
              position: reference.position,
              before: reference.href,
              after: path,
              target: before.page.page,
            });
            return path;
          },
          { allowCompiledAssetReferences: true },
        );
        if (!rewritten.ok)
          return failure(
            "source-reference-unrepresentable",
            "Initial source grammar cannot preserve a page reference.",
          );
        page.spec.content.value = rewritten.content;
      }
      config = {
        id: wiki.name,
        title: wiki.spec.title,
        sourceVersion: 1,
        ...(wiki.labels !== undefined ? { labels: wiki.labels } : {}),
        ...(Object.hasOwn(wiki.spec, "description") ? { description: wiki.spec.description } : {}),
        ...(wiki.spec.theme !== undefined ? { theme: wiki.spec.theme } : {}),
        ...(source.assetDirectory !== undefined ? { assets: { directory: assetDirectory } } : {}),
        ...(wiki.spec.navigation !== undefined
          ? { navigation: sourceNavigation(wiki.spec.navigation, wiki, paths, directory) }
          : {}),
      };
      parseWikiConfig(config);
    }
    for (const resource of expected.filter(
      (resource): resource is Guide | WikiPage =>
        resource.type === "Guide" || resource.type === "WikiPage",
    )) {
      const path = paths.get(`${resource.type}/${resource.name}`)!;
      const metadata = {
        id: resource.name,
        title: resource.spec.title,
        ...(Object.hasOwn(resource.spec, "description")
          ? { description: resource.spec.description }
          : {}),
        ...(resource.labels !== undefined ? { labels: resource.labels } : {}),
        ...(resource.type === "Guide"
          ? {
              slug: resource.spec.slug,
              inheritTags: false,
              ...(resource.spec.authors !== undefined ? { authors: resource.spec.authors } : {}),
              ...(resource.spec.tags !== undefined ? { tags: resource.spec.tags } : {}),
            }
          : {}),
      };
      add(
        path,
        `---\n${Object.entries(metadata)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
          .join("")}---\n${authoredBody(resource, path, assets)}`,
      );
    }
    add(
      source.config,
      source.config.endsWith(".json")
        ? `${JSON.stringify(config, null, 2)}\n`
        : Object.entries(config)
            .map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`)
            .join(""),
    );
    let rootEdits: SourceByteEdit[] | undefined;
    if (existing) {
      parseTopikManifest({
        ...existing.project.manifest,
        sources: [
          ...existing.project.manifest.sources,
          { kind: source.kind, config: source.config },
        ],
      });
      const root = occupied.find((file) => file.path === ".topik.yaml")!;
      rootEdits = patchSourceSequence(
        decodeSource(root.bytes),
        "sources",
        [{ kind: source.kind, config: source.config }],
        [],
      );
      verifySharedEdits(
        root,
        existing.project.configurations.find((config) => config.path === ".topik.yaml")!,
        existing.authority,
        rootEdits,
      );
      generatedFiles.push({
        path: root.path,
        mode: root.mode,
        bytes: replaySourceByteEdits(root.bytes, rootEdits),
      });
    } else
      add(
        ".topik.yaml",
        `version: 1\nnamespace: ${JSON.stringify(manifest.namespace)}\nsources:\n  - kind: ${source.kind}\n    config: ${JSON.stringify(source.config)}\n`,
      );
    if (
      generatedFiles.some(
        (file) =>
          !(existing && file.path === ".topik.yaml") &&
          (occupied.some((existing) => existing.path === file.path) ||
            !input.createPaths.includes(file.path)),
      ) ||
      !validateTopikPathSet(
        [
          ...occupied.filter((file) => !(existing && file.path === ".topik.yaml")),
          ...generatedFiles,
        ].map((file) => file.path),
      ).ok ||
      new Set(generatedFiles.map((file) => file.path)).size !== generatedFiles.length
    )
      return failure(
        "initialization-collision",
        "Every new path requires admitted absence and must avoid all occupied/colliding paths.",
      );
    const candidate = await readSourceProject({
      tree: [
        ...occupied.filter((file) => !(existing && file.path === ".topik.yaml")),
        ...generatedFiles,
      ],
    });
    // Compiler remaps local media identities; supplied byte metadata must still match exactly.
    for (const resource of expected) {
      if (resource.type !== "Guide" && resource.type !== "WikiPage") continue;
      const original = candidate.compilation.resources.find(
        (other) => other.type === resource.type && other.name === resource.name,
      );
      if (!original || (original.type !== "Guide" && original.type !== "WikiPage"))
        return failure(
          "round-trip-mismatch",
          "A created document did not compile to its stable identity.",
        );
      const normalized = {
        ...original,
        spec: { ...original.spec, content: resource.spec.content },
      } as Resource;
      if (canonicalResource(normalized) !== canonicalResource(resource))
        return failure(
          "round-trip-mismatch",
          "Created source metadata does not reproduce the desired resource.",
        );
      // Replace only proven Asset identity tokens, then compare all authored content.
      const mapped = rewriteTopikAssetOccurrences(
        resource.spec.content.value,
        (occurrence) => {
          if (!occurrence.reference.startsWith("asset:")) return undefined;
          const target = assetMappings.get(occurrence.reference.slice(6));
          return target ? `asset:${target}` : undefined;
        },
        { allowCompiledAssetReferences: true, includeGenericLinkCandidates: true },
      );
      if (!mapped.ok)
        return failure(
          "round-trip-mismatch",
          "Asset identity mapping could not preserve authoring content.",
        );
      resource.spec.content.value = mapped.content;
    }
    if (existing) expected.push(...structuredClone(existing.project.compilation.resources));
    const compiled = new Map(
      candidate.compilation.resources.map((resource) => [
        `${resource.type}/${resource.name}`,
        resource,
      ]),
    );
    if (
      compiled.size !== expected.length ||
      expected.some(
        (resource) =>
          !compiled.has(`${resource.type}/${resource.name}`) ||
          canonicalResource(resource) !==
            canonicalResource(compiled.get(`${resource.type}/${resource.name}`)!),
      )
    )
      return failure(
        "round-trip-mismatch",
        "The initialized source project does not reproduce the complete desired graph.",
      );
    const changes: SourceFileChange[] = generatedFiles
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
      .map((file) => ({
        kind: existing && file.path === ".topik.yaml" ? "update" : "create",
        path: file.path,
        base:
          existing && file.path === ".topik.yaml"
            ? { sha256: existing.project.manifestSha256, mode: file.mode }
            : null,
        candidate: { mode: file.mode, sha256: sourceHash(file.bytes), bytes: file.bytes },
        ...(existing && file.path === ".topik.yaml" ? { sharedEdits: rootEdits } : {}),
      }));
    const desiredGraphDigest = digestSourceResourceGraph([
      ...(existing?.project.compilation.resources ?? []),
      ...input.resources,
    ]);
    const evidence = {
      descriptor: SOURCE_WRITER_DESCRIPTOR,
      packageCohort: input.packageCohort,
      baseTreeDigest,
      desiredGraphDigest,
      intent: input.intent,
      referenceContexts: input.referenceContexts ?? null,
      assetReferenceContexts: input.assetReferenceContexts ?? null,
      documentPaths: input.documentPaths ?? null,
      createPaths: input.createPaths,
      manifestAuthority: existing?.authority ?? null,
      media: (input.media ?? []).map((selection) => ({
        name: selection.name,
        filename: selection.filename,
        sha256: selection.sha256,
      })),
      candidateTreeDigest: candidate.treeDigest,
      assetMappings: [...assetMappings],
      changes: changes.map((change) => ({
        path: change.path,
        candidate: change.candidate!.sha256,
      })),
    };
    return {
      ok: true,
      plan: {
        descriptor: SOURCE_WRITER_DESCRIPTOR,
        packageCohort: input.packageCohort,
        baseTreeDigest,
        desiredGraphDigest,
        candidateTreeDigest: candidate.treeDigest,
        planDigest: sourceHash(encodeSource(serializeTopikJson(evidence))),
        changes,
        candidate,
        derivedRepairs,
        assetMappings: [...assetMappings].map(([from, to]) => ({
          from,
          to,
          path: assets.get(from)!,
        })),
        affectedResources: input.resources
          .map((resource) => `${resource.type}/${resource.name}`)
          .sort(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: sourcePlanDiagnostics(error, {
        code: "initialization-validation-failed",
        message: "Source initialization failed validation; no files may be applied.",
      }),
    };
  }
}
