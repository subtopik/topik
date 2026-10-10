import { tagOptions } from "./tag-options.js";
import type { Node } from "mdast";
import type { AuthoredAttributeValue, ContentDocument, Diagnostic, TreeNode } from "./model.js";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import {
  tagFromMarkdown,
  tagSyntax,
  TagSyntaxError,
  type TagDeclarations,
} from "@topik/remark-tags";
import { gfmSyntax, gfmFromMarkdown } from "./gfm.js";
import { headingIdFromMarkdown, headingIdSyntax } from "./heading-ids.js";
import { parseExpression } from "./expressions.js";
import { referenceSourceExtension } from "./reference-source.js";
import { components, type Registry } from "./registry.js";
import { diagnostic, validateDocumentWithIndex, validateTag, type Tag } from "./validation.js";
import type { DocumentIndex } from "./document-index.js";
import {
  assertSourceLimit,
  assertTreeLimits,
  CONTENT_LIMITS,
  ContentLimitError,
  limitDiagnostic,
} from "./limits.js";
import { parserLimitSyntax } from "./parser-limits.js";
import { normalizeLineEndings } from "./line-endings.js";
import {
  CodePresentationError,
  codePresentationChildRows,
  parseCodePresentationMetadata,
} from "./code-presentation.js";

function declarations(registry: Registry): TagDeclarations {
  return Object.fromEntries(
    Object.entries(registry).map(([name, definition]) => [name, { kind: definition.kind }]),
  );
}

export function convertTags(
  root: TreeNode,
  registry: Registry,
  rawHeaders?: WeakMap<Node, string>,
): Diagnostic[] {
  const errors: Diagnostic[] = [];
  let presentationFailed = false;
  function walk(node: TreeNode): void {
    if (!node.children) return;
    node.children = node.children.map((originalChild) => {
      let child = originalChild;
      walk(child);
      if (child.type === "tagVariable")
        return {
          type: "topikVariable",
          path: String(child.path).split("."),
          position: child.position,
        };
      if (child.type === "tagBranch") {
        if (typeof child.condition === "string") {
          try {
            child.condition = parseExpression(child.condition);
          } catch (error) {
            if (error instanceof ContentLimitError) throw error;
            errors.push(diagnostic((error as Error).message, child));
          }
        }
        return { ...child, type: "topikBranch" };
      }
      if (child.type === "tagConditional") return { ...child, type: "topikConditional" };
      if (child.type === "tagCodeTemplate")
        child = {
          type: "topikCodeTemplate",
          lang: child.lang,
          meta: child.meta,
          template: child.template,
          position: child.position,
        };
      if (child.type === "code" || child.type === "topikCodeTemplate") {
        const rawHeader = rawHeaders?.get(originalChild);
        if (rawHeader === undefined) return child;
        const unlabelled =
          /^(?:(?:lines|wrap)(?:[ \t=]|$)|(?:filename|title|startLine|highlight|focus|collapseAfter|added|removed)[ \t]*=)/.test(
            rawHeader,
          );
        const rawMeta = unlabelled ? rawHeader : rawHeader.replace(/^[^ \t]+[ \t]*/, "");
        try {
          const presentation = parseCodePresentationMetadata(
            rawMeta,
            codePresentationChildRows(child),
          );
          if (!presentation) return child;
          if (unlabelled) child.lang = null;
          delete child.meta;
          return {
            type: "topikCodePresentation",
            ...presentation,
            children: [child],
            position: child.position,
          };
        } catch (error) {
          if (!(error instanceof CodePresentationError)) throw error;
          presentationFailed = true;
          errors.push(
            diagnostic(
              {
                id: error.id,
                message: error.message,
                ...(error.option ? { option: error.option } : {}),
              },
              child,
            ),
          );
          return child;
        }
      }
      if (!["tagText", "tagLeaf", "tagContainer"].includes(child.type)) return child;
      const props: Record<string, AuthoredAttributeValue> = {};
      for (const [key, value] of Object.entries(child.attributes ?? {})) {
        if (value !== null && value !== undefined) props[key] = value;
      }
      const definition =
        child.name && Object.hasOwn(registry, child.name) ? registry[child.name] : undefined;
      const tag: Tag = {
        name: child.name ?? "",
        close: false,
        selfClosing:
          child.type === "tagLeaf" || (child.type === "tagText" && definition?.children === "none"),
        props,
      };
      const invalid = validateTag(tag, registry);
      if (invalid) errors.push(diagnostic(invalid, child));
      if (child.type === "tagLeaf" && child.children?.length)
        errors.push(diagnostic(`Leaf component ${child.name} cannot contain children`, child));
      return {
        type: "topikComponent",
        name: child.name,
        props,
        children: child.children ?? [],
        position: child.position,
      } as TreeNode;
    });
  }
  walk(root);
  // Collect sibling errors without exposing malformed fences as ordinary code.
  if (presentationFailed) throw new TagSyntaxError(errors);
  return errors;
}

export const FORMAT_VERSION = 1;

export interface DocumentTreeResult {
  source: string;
  document?: ContentDocument;
  index?: DocumentIndex;
  diagnostics: Diagnostic[];
}

/** Parse and convert even when semantic validation fails; syntax failures omit the tree. */
export function parseDocumentTree(
  source: string,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): DocumentTreeResult {
  if (formatVersion !== FORMAT_VERSION)
    return {
      diagnostics: [
        { id: "topik-format-version", message: `Unsupported format version ${formatVersion}` },
      ],
      source,
    };
  let tree: ContentDocument;
  try {
    assertSourceLimit(source);
    const normalized = normalizeLineEndings(source);
    const rawHeaders = new WeakMap<Node, string>();
    const syntaxOptions = { ...tagOptions(registry), fencedCodeHeaders: rawHeaders };
    tree = fromMarkdown(normalized.source, {
      extensions: [
        frontmatter(),
        ...gfmSyntax(),
        tagSyntax(declarations(registry), syntaxOptions),
        headingIdSyntax(),
        parserLimitSyntax(normalized.source),
      ],
      mdastExtensions: [
        {
          transforms: [
            (root) => {
              assertTreeLimits(root as TreeNode);
              return root;
            },
          ],
        },
        ...gfmFromMarkdown(),
        frontmatterFromMarkdown(),
        tagFromMarkdown(declarations(registry), syntaxOptions),
        {
          transforms: [
            (root) => {
              assertTreeLimits(root as TreeNode);
              return root;
            },
          ],
        },
        referenceSourceExtension(),
        headingIdFromMarkdown(),
        {
          exit: {
            resourceTitle() {
              const node = this.stack.at(-1) as { title?: string | null };
              if (node.title === null) node.title = "";
            },
            definitionTitle() {
              const node = this.stack.at(-1) as { title?: string | null };
              if (node.title === null) node.title = "";
            },
          },
        },
      ],
    }) as ContentDocument;
    const nodeCount = assertTreeLimits(tree as TreeNode);
    normalized.restorePositions(tree as TreeNode);
    const tagErrors = convertTags(tree as TreeNode, registry, rawHeaders);
    normalizeTables(tree as TreeNode, CONTENT_LIMITS.treeNodes - nodeCount);
    const validated = validateDocumentWithIndex(tree, registry);
    const errors = tagErrors.concat(validated.diagnostics);
    return { document: tree, index: validated.index, diagnostics: errors, source };
  } catch (error) {
    if (error instanceof ContentLimitError)
      return { diagnostics: [limitDiagnostic(error)], source };
    if (error instanceof TagSyntaxError)
      return {
        diagnostics: error.diagnostics.map((item) => ({
          ...item,
          ...("id" in item && item.id === "tag-content-limit" ? { id: "topik-content-limit" } : {}),
          ...(item.message.startsWith("Unknown tag ") ? { id: "tag-undefined" } : {}),
          message: item.message.replace(/^Unknown tag /, "Unknown component "),
        })),
        source,
      };
    throw error;
  }
}

/** GFM missing cells mean empty cells; overflow is retained for an explicit diagnostic. */
function normalizeTables(root: TreeNode, remainingNodes: number): void {
  function walk(node: TreeNode): void {
    if (node.type === "table") {
      const width = node.children?.[0]?.children?.length ?? 0;
      for (const row of node.children ?? []) {
        if (!row.children) continue;
        const missing = Math.max(0, width - row.children.length);
        if (missing > remainingNodes)
          throw new ContentLimitError(
            `Content exceeds the tree node limit of ${CONTENT_LIMITS.treeNodes}`,
          );
        remainingNodes -= missing;
        while (row.children.length < width) row.children.push({ type: "tableCell", children: [] });
      }
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(root);
}
