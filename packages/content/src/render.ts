import type { RootContent } from "mdast";
import type { Branch, ContentDocument } from "./model.js";
import {
  mergeTopikContentConfig,
  type TopikContentConfig,
  type ResolvedTopikContentConfig,
} from "./config.js";
import { evaluateDocumentForRendering } from "./evaluate.js";
import { getEffectiveProps } from "./registry.js";
import {
  effectiveCodePresentationOptions,
  normalizeCodePresentationOptions,
  codePresentationRows,
} from "./code-presentation.js";
import { assertCodePresentationOutputLimit } from "./presentation-output.js";
import { validateTopikHref, validateTopikNavigationHref } from "./links.js";
import { footnoteAnchor, footnoteKey, numberFootnotes } from "./footnotes.js";
import type { TreeNode } from "./model.js";

/**
 * Defence in depth for documents that never passed source admission, such as
 * `parseDocument` output passed straight to `transformTopikContent`. Admitted
 * source already satisfies these policies, so compiled output is unchanged.
 */
function admitsUrl(value: string, validate = validateTopikHref): boolean {
  return validate(value).length === 0;
}

/** Framework-independent, serializable output. It contains no executable values. */
export type RenderableTreeNode =
  | ContentTag
  | string
  | number
  | boolean
  | null
  | RenderableTreeNode[];

export class ContentTag {
  readonly type = "element";
  constructor(
    public name: string,
    public attributes: Record<string, unknown> = {},
    public children: RenderableTreeNode[] = [],
  ) {}
}

export function isContentTag(value: unknown): value is ContentTag {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "element" &&
    "name" in value &&
    typeof value.name === "string" &&
    "attributes" in value &&
    value.attributes !== null &&
    typeof value.attributes === "object" &&
    "children" in value &&
    Array.isArray(value.children)
  );
}

/** Render a validated authored document through a separate evaluated document. */
export function transformTopikContent(
  document: ContentDocument,
  options: TopikContentConfig = {},
): RenderableTreeNode {
  return transformDocument(document, mergeTopikContentConfig(options));
}

/** @internal Source compilation already owns an isolated configuration snapshot. */
export function transformDocument(
  document: ContentDocument,
  config: ResolvedTopikContentConfig,
): RenderableTreeNode {
  const resolved = evaluateDocumentForRendering(document, config.variables, config.components);
  assertCodePresentationOutputLimit(resolved);
  const footnotes = numberFootnotes(
    resolved,
    (node) =>
      node.type === "topikComponent" &&
      config.components[(node as TreeNode & { name: string }).name]?.render === false,
  );

  /** Shown footnotes as one list after the content, in order of first reference. */
  function footnoteList(): RenderableTreeNode {
    const definitions = resolved.children
      .filter((child) => child.type === "footnoteDefinition")
      .map((child) => ({ child, number: footnotes.numbers.get(footnoteKey(child as TreeNode)) }))
      .filter((entry): entry is { child: (typeof entry)["child"]; number: number } =>
        Number.isInteger(entry.number),
      )
      .sort((left, right) => left.number - right.number);
    if (!definitions.length) return null;
    return new ContentTag(
      "TopikFootnotes",
      {},
      definitions.map(
        ({ child, number }) =>
          new ContentTag(
            "TopikFootnote",
            {
              number,
              id: footnoteAnchor(number),
              backrefs: footnotes.backrefs.get(footnoteKey(child as TreeNode)) ?? [],
            },
            "children" in child ? child.children.map((item) => render(item as RootContent)) : [],
          ),
      ),
    );
  }

  function render(
    node: ContentDocument | RootContent | Branch,
    looseList = false,
  ): RenderableTreeNode {
    const children = (): RenderableTreeNode[] =>
      "children" in node ? node.children.map((child) => render(child)) : [];
    const tag = (name: string, attributes: Record<string, unknown> = {}, body = children()) =>
      new ContentTag(name, attributes, body);
    switch (node.type) {
      case "root": {
        const list = footnoteList();
        return tag("article", {}, list === null ? children() : [...children(), list]);
      }
      case "footnoteReference": {
        const number = footnotes.numbers.get(footnoteKey(node as TreeNode));
        if (number === undefined) return null;
        return tag(
          "TopikFootnoteReference",
          {
            number,
            id: footnotes.anchors.get(node as TreeNode),
            target: footnoteAnchor(number),
          },
          [],
        );
      }
      case "footnoteDefinition":
        return null;
      case "text":
        return node.value;
      case "paragraph":
        return tag("p");
      case "heading":
        return tag(`h${node.depth}`, { id: node.data?.hProperties?.id });
      case "strong":
        return tag("strong");
      case "emphasis":
        return tag("em");
      case "delete":
        return tag("s");
      case "inlineCode":
        return tag("TopikInlineCode", {}, [node.value]);
      case "code":
        return tag(
          node.lang === "mermaid" ? "TopikMermaid" : "TopikCodeBlock",
          {
            payload: node.value,
            content: `${node.value}\n`,
            language: node.lang ?? "",
          },
          [],
        );
      case "topikCodePresentation": {
        const code = node.children[0];
        if (code.type !== "code") throw new Error("Presented code must be evaluated first");
        return tag(
          "TopikCodeBlock",
          {
            payload: code.value,
            content: `${code.value}\n`,
            language: code.lang ?? "",
            presentation: effectiveCodePresentationOptions(
              normalizeCodePresentationOptions(node.options, codePresentationRows(code.value)),
            ),
          },
          [],
        );
      }
      case "break":
        return tag("br", {}, []);
      case "thematicBreak":
        return tag("hr", {}, []);
      case "blockquote":
        return tag("blockquote");
      case "list": {
        // Looseness belongs to the entire list, including sibling paragraphs.
        const loose =
          node.spread === true ||
          node.children.some((item) => item.spread ?? item.children.length > 1);
        return tag(
          node.ordered ? "ol" : "ul",
          node.ordered && node.start != null && node.start !== 1 ? { start: node.start } : {},
          node.children.map((item) => render(item, loose)),
        );
      }
      case "listItem": {
        const body = node.children.flatMap((child) =>
          !looseList && child.type === "paragraph"
            ? child.children.map((item) => render(item))
            : [render(child)],
        );
        if (typeof node.checked === "boolean") {
          const checkbox = new ContentTag("input", {
            type: "checkbox",
            checked: node.checked,
            disabled: true,
          });
          // Task markers are part of the first paragraph in loose lists.
          if (looseList && isContentTag(body[0]) && body[0].name === "p")
            body[0].children.unshift(checkbox);
          else body.unshift(checkbox);
        }
        return tag("li", {}, body);
      }
      case "image":
        return tag(
          "TopikImage",
          {
            ...(admitsUrl(node.url) ? { src: node.url } : {}),
            alt: node.alt ?? "",
            ...(node.title != null ? { title: node.title } : {}),
          },
          [],
        );
      case "link":
        return tag("TopikLink", {
          ...(admitsUrl(node.url) ? { href: node.url } : {}),
          ...(node.title != null ? { title: node.title } : {}),
        });
      case "yaml":
      case "definition":
        return null;
      case "table": {
        const width = node.children[0].children.length;
        const rows = node.children.map(
          (row, rowIndex) =>
            new ContentTag(
              "TopikTableRow",
              {},
              Array.from(
                { length: width },
                (_, column) =>
                  new ContentTag(
                    rowIndex === 0 ? "TopikTableHeader" : "TopikTableCell",
                    node.align?.[column] ? { align: node.align[column] } : {},
                    (row.children[column]?.children ?? []).map((child) => render(child)),
                  ),
              ),
            ),
        );
        return tag("TopikTable", {}, [
          new ContentTag("thead", {}, rows.slice(0, 1)),
          new ContentTag("tbody", {}, rows.slice(1)),
        ]);
      }
      case "topikComponent": {
        const definition = config.components[node.name];
        if (definition.render === false) return null;
        if (definition.render === true) return children();
        const props = getEffectiveProps(node, config.components);
        for (const [name, attribute] of Object.entries(definition.attributes)) {
          const navigation = node.name === "card" && name === "href";
          const value = props[name];
          if (
            typeof value !== "string" ||
            !(navigation || attribute.asset || attribute.assetReference)
          )
            continue;
          if (!admitsUrl(value, navigation ? validateTopikNavigationHref : validateTopikHref))
            delete props[name];
        }
        return tag(definition.render, props);
      }
      default:
        throw new Error(`Unsupported evaluated content node ${node.type}`);
    }
  }
  return render(resolved);
}
