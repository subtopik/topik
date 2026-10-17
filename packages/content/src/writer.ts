import { tagOptions } from "./tag-options.js";
import type { Root } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { frontmatterToMarkdown } from "mdast-util-frontmatter";
import { tagToMarkdown } from "@topik/remark-tags";
import type { Component, ContentDocument, TextTemplate, TreeNode } from "./model.js";
import { components, type Registry } from "./registry.js";
import { writeExpression } from "./expressions.js";
import { validateDocument } from "./validation.js";
import { FORMAT_VERSION, parseDocumentTree } from "./parser.js";
import { sameDocumentMeaning } from "./document-meaning.js";
import { gfmToMarkdown } from "./gfm.js";
import { markWriterExtension } from "./markdown-marks.js";
import { headingIdToMarkdown } from "./heading-ids.js";
import { resourceWriterExtension } from "./resource-writer.js";
import { referenceWriterExtension } from "./reference-writer.js";
import { boundaryWhitespaceWriterExtension } from "./whitespace-writer.js";
import { assertSourceLimit, CONTENT_LIMITS, ContentLimitError } from "./limits.js";
import { codeWriterExtension, ordinaryCodeFenceLength } from "./code-writer.js";
import { codePresentationWriterExtension } from "./code-presentation-writer.js";
import { codePresentationMetadataLength } from "./code-presentation.js";

/**
 * Count payload deltas from an empty-template/code skeleton. A cheap source
 * floor refuses obvious overflows before cloning or baseline serialization;
 * the existing writer then supplies exact ordinary markup and escaping.
 */
function sourceExpansion(document: ContentDocument, registry: Registry): number {
  let total = 0;
  let expansion = 0;
  function charge(length: number): void {
    total += length;
    if (total > CONTENT_LIMITS.sourceLength)
      throw new ContentLimitError(
        `Content exceeds the source length limit of ${CONTENT_LIMITS.sourceLength}`,
      );
  }
  function attributeEscape(unit: string, table: boolean, label: boolean): boolean {
    return (
      unit === '"' ||
      unit === "\\" ||
      (table && unit === "|") ||
      (label && (unit === "[" || unit === "]"))
    );
  }
  function measure(
    template: TextTemplate,
    attribute: boolean,
    table: boolean,
    label: boolean,
    escapeOpeners = true,
  ) {
    let length = 0;
    let previous = "";
    let ticks = 0;
    let tildes = 0;
    let longestTicks = 0;
    let longestTildes = 0;
    let blankLines = 0;
    let nonblankLines = 0;
    let lineHasContent = false;
    for (const segment of template.segments) {
      if (segment.type === "variable") {
        length += 7 + segment.path.length - 1;
        for (const part of segment.path) length += part.length;
        lineHasContent = true;
        previous = "";
        ticks = 0;
        tildes = 0;
        continue;
      }
      for (const unit of segment.value) {
        length += unit.length;
        if (escapeOpeners && previous === "{" && unit === "%") length++;
        if (attribute && attributeEscape(unit, table, label)) length++;
        ticks = unit === "`" ? ticks + 1 : 0;
        tildes = unit === "~" ? tildes + 1 : 0;
        longestTicks = Math.max(longestTicks, ticks);
        longestTildes = Math.max(longestTildes, tildes);
        previous = unit;
        if (unit === "\n") {
          if (lineHasContent) nonblankLines++;
          else blankLines++;
          lineHasContent = false;
        } else lineHasContent = true;
      }
    }
    if (length) {
      if (lineHasContent) nonblankLines++;
      else blankLines++;
    }
    return { length, longestTicks, longestTildes, blankLines, nonblankLines };
  }
  function headerLength(value: string | null | undefined): number {
    let length = value?.length ?? 0;
    for (const unit of value ?? "")
      length += unit === "&" || unit === "\t" ? 4 : unit === "\\" || unit === "`" ? 5 : 0;
    return length;
  }
  type Prefix = "quote" | number;
  function prefixWidths(prefixes: readonly Prefix[]) {
    let blank = 0;
    let nonblank = 0;
    let empty = true;
    for (let index = prefixes.length - 1; index >= 0; index--) {
      const prefix = prefixes[index];
      nonblank += prefix === "quote" ? 2 : prefix;
      if (prefix === "quote") {
        blank += empty ? 1 : 2;
        empty = false;
      } else if (!empty) blank += prefix;
    }
    return { blank, nonblank };
  }
  function walk(
    node: TreeNode,
    table = false,
    label = false,
    prefixes: readonly Prefix[] = [],
    parent?: TreeNode,
    index = 0,
  ): void {
    if (node.type === "topikCodePresentation")
      charge(
        1 +
          (node.children?.[0]?.lang ? 1 : 0) +
          codePresentationMetadataLength(node.options!, node.opaqueMetaSuffix!),
      );
    if (node.type === "topikCodeTemplate" || node.type === "code") {
      const explicit = node.type === "topikCodeTemplate";
      const presented = parent?.type === "topikCodePresentation";
      const measured = measure(
        explicit
          ? node.template!
          : { type: "topikTextTemplate", segments: [{ type: "literal", value: node.value! }] },
        false,
        false,
        false,
        explicit,
      );
      const ticks = Math.max(3, measured.longestTicks + 1);
      const tildes = Math.max(3, measured.longestTildes + 1);
      const fence =
        explicit || presented
          ? node.lang?.includes("`") || node.meta?.includes("`")
            ? tildes
            : Math.min(ticks, tildes)
          : ordinaryCodeFenceLength(node.value!);
      const prefix = prefixWidths(prefixes);
      const payload =
        (measured.length ? measured.length + 1 : 0) +
        measured.nonblankLines * prefix.nonblank +
        measured.blankLines * prefix.blank;
      expansion += payload + 2 * (fence - 3);
      charge(
        (explicit ? 42 : 1) +
          2 * fence +
          (explicit || presented ? headerLength(node.lang) : (node.lang?.length ?? 0)) +
          (node.meta
            ? 1 +
              (explicit
                ? headerLength(node.meta) + (node.meta.startsWith(" ") ? 5 : 0)
                : node.meta.length)
            : 0) +
          payload +
          (explicit ? 4 : 2) * prefix.nonblank,
      );
    }
    if (
      ["text", "inlineCode", "html", "yaml"].includes(node.type) &&
      typeof node.value === "string"
    )
      charge(node.value.length);
    if (node.type === "topikComponent") {
      let templated = false;
      for (const [name, value] of Object.entries(node.props ?? {}))
        if (value && typeof value === "object") {
          const length = measure(value, true, table, label).length;
          expansion += length;
          charge(name.length + 5 + length);
          templated = true;
        } else if (typeof value === "string") {
          let length = name.length + 4 + value.length;
          for (const unit of value) if (attributeEscape(unit, table, label)) length++;
          charge(length);
        }
      if (templated) {
        const definition = registry[node.name!];
        const count = node.children?.length ?? 0;
        const leaf =
          (count === 0 && (definition.kind === "inline" || definition.selfClosing)) ||
          definition.children === "none";
        const wrapper = leaf
          ? 7 + node.name!.length
          : 13 + 2 * node.name!.length + (definition.kind === "block" ? 1 : 0);
        charge(
          wrapper +
            (leaf || definition.kind === "inline" ? 1 : 2) * prefixWidths(prefixes).nonblank,
        );
      }
    }
    let childPrefixes = prefixes;
    if (node.type === "blockquote") childPrefixes = [...prefixes, "quote"];
    else if (node.type === "listItem") {
      const list = parent as (TreeNode & { ordered?: boolean; start?: number }) | undefined;
      // These are the explicit writer options below: one space after the marker,
      // incremented ordered markers, and one-character unordered markers.
      const width = list?.ordered ? String((list.start ?? 1) + index).length + 2 : 2;
      childPrefixes = [...prefixes, width];
    }
    for (const [childIndex, child] of (node.children ?? []).entries()) {
      walk(
        child,
        table || node.type === "tableCell",
        label || node.type === "link" || node.type === "linkReference",
        childPrefixes,
        node,
        childIndex,
      );
      const next = node.children?.[childIndex + 1];
      if (
        next &&
        [child, next].some((sibling) =>
          ["code", "topikCodeTemplate", "topikCodePresentation"].includes(sibling.type),
        )
      ) {
        const spread = (node as TreeNode & { spread?: boolean }).spread;
        const separator = spread === false ? 1 : 2;
        charge(separator + (separator - 1) * prefixWidths(childPrefixes).blank);
      }
    }
  }
  walk(document as TreeNode);
  return expansion;
}

function asTags(root: ContentDocument, registry: Registry, emptyPayloads = false): Root {
  const cloned = structuredClone(root) as TreeNode;
  function walk(node: TreeNode): void {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      walk(child);
      if (child.type === "topikVariable")
        return { type: "tagVariable", path: (child.path as string[]).join(".") };
      if (child.type === "topikBranch")
        return {
          type: "tagBranch",
          condition: child.condition === null ? null : writeExpression(child.condition as never),
          children: child.children,
        };
      if (child.type === "topikConditional")
        return { type: "tagConditional", children: child.children };
      if (child.type === "topikCodeTemplate")
        return {
          type: "tagCodeTemplate",
          lang: child.lang,
          meta: child.meta,
          template: emptyPayloads ? { type: "topikTextTemplate", segments: [] } : child.template,
        };
      if (child.type === "code" && emptyPayloads) child.value = "";
      if (child.type !== "topikComponent") return child;
      const component = child as TreeNode & Component;
      const definition = registry[component.name];
      return {
        type:
          definition.kind === "inline"
            ? "tagText"
            : definition.children === "none" ||
                (definition.selfClosing && component.children.length === 0)
              ? "tagLeaf"
              : "tagContainer",
        name: component.name,
        attributes: emptyPayloads
          ? Object.fromEntries(
              Object.entries(component.props).map(([name, value]) => [
                name,
                typeof value === "object" ? { type: "topikTextTemplate", segments: [] } : value,
              ]),
            )
          : component.props,
        children: component.children,
      };
    });
  }
  walk(cloned);
  return cloned as Root;
}

export function writeDocument(
  document: ContentDocument,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): string {
  const written = serializeDocument(document, registry, formatVersion);
  const parsed = parseDocumentTree(written, registry, formatVersion);
  if (
    !parsed.document ||
    parsed.diagnostics.length ||
    !sameDocumentMeaning(document, parsed.document)
  )
    throw new Error("Content cannot be serialized without changing its meaning");
  return written;
}

/** @internal Source operations reuse their output admission parse for the meaning check. */
export function serializeDocument(
  document: ContentDocument,
  registry: Registry = components,
  formatVersion = FORMAT_VERSION,
): string {
  if (formatVersion !== FORMAT_VERSION)
    throw new Error(`Unsupported format version ${formatVersion}`);
  const errors = validateDocument(document, registry);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
  const expansion = sourceExpansion(document, registry);
  const baseline = writeMarkdown(asTags(document, registry, true), registry);
  assertSourceLimit(baseline);
  if (expansion === 0) return baseline;
  if (baseline.length + expansion > CONTENT_LIMITS.sourceLength)
    throw new ContentLimitError(
      `Content exceeds the source length limit of ${CONTENT_LIMITS.sourceLength}`,
    );
  const written = writeMarkdown(asTags(document, registry), registry);
  assertSourceLimit(written);
  return written;
}

function writeMarkdown(tree: Root, registry: Registry): string {
  return toMarkdown(tree, {
    extensions: [
      gfmToMarkdown(),
      markWriterExtension(tree as TreeNode),
      frontmatterToMarkdown(),
      tagToMarkdown(
        Object.fromEntries(
          Object.entries(registry).map(([name, definition]) => [name, { kind: definition.kind }]),
        ),
        tagOptions(registry),
      ),
      codeWriterExtension(),
      codePresentationWriterExtension(),
      resourceWriterExtension(),
      referenceWriterExtension(),
      boundaryWhitespaceWriterExtension() as never,
      headingIdToMarkdown(),
    ],
    bullet: "-",
    listItemIndent: "one",
    incrementListMarker: true,
    fences: true,
  });
}
