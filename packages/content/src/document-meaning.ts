import type { ContentDocument, TextTemplate, TreeNode } from "./model.js";
import { referenceIdentifier } from "./document-index.js";
import {
  codePresentationChildRows,
  normalizeCodePresentationOptions,
} from "./code-presentation.js";

/** Compare admitted authoring trees, retaining explicit heading IDs and every authored branch.
 * Source positions, cosmetic spelling and derived metadata do not affect equality.
 * This compares meaning; it does not validate arbitrary caller-constructed trees.
 */
export function sameDocumentMeaning(left: ContentDocument, right: ContentDocument): boolean {
  return equal(meaning(left as TreeNode), meaning(right as TreeNode));
}

function meaning(node: TreeNode): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...node };
  delete fields.position;
  delete fields.data;
  delete fields.children;
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];

  if (node.type === "heading") {
    const data = (node as TreeNode & { data?: { topikId?: string } }).data;
    fields.topikId = data?.topikId ?? null;
  }
  if (node.type === "link" || node.type === "image" || node.type === "definition")
    fields.title ??= null;
  if (node.type === "image" || node.type === "imageReference") fields.alt ??= "";
  if (node.type === "code" || node.type === "topikCodeTemplate") {
    fields.lang ??= null;
    fields.meta ??= null;
  }
  if (node.type === "topikCodeTemplate") fields.template = templateMeaning(node.template!);
  if (node.type === "topikCodePresentation")
    fields.options = normalizeCodePresentationOptions(
      node.options,
      codePresentationChildRows(node.children![0]),
    );
  if (node.type === "topikComponent" && node.props)
    fields.props = Object.fromEntries(
      Object.entries(node.props).map(([key, value]) => [
        key,
        typeof value === "object" ? templateMeaning(value) : value,
      ]),
    );
  if (["definition", "linkReference", "imageReference"].includes(node.type)) {
    fields.identifier = referenceIdentifier(fields.identifier as string);
    // A full label can replace a shortcut without changing its definition binding.
    delete fields.label;
    delete fields.referenceType;
  }
  if (node.type === "list") {
    fields.ordered ??= false;
    fields.start = fields.ordered ? (fields.start ?? 1) : null;
    // Markdown spelling can move a blank line between items and their children.
    // The significant property is whether the entire list renders loosely.
    fields.spread =
      fields.spread === true ||
      (node.children ?? []).some((item) => {
        const spread = (item as TreeNode & { spread?: boolean }).spread;
        return spread ?? (item.children?.length ?? 0) > 1;
      });
  }
  if (node.type === "listItem") {
    delete fields.spread;
    fields.checked ??= null;
  }
  if (node.type === "table")
    fields.align ??= Array.from({ length: node.children?.[0]?.children?.length ?? 0 }, () => null);

  if (node.children) {
    const children: Record<string, unknown>[] = [];
    for (const child of node.children) {
      const next = meaning(child);
      const previous = children.at(-1);
      if (previous?.type === "text" && next.type === "text")
        previous.value = String(previous.value) + String(next.value);
      else children.push(next);
    }
    fields.children = children;
  }
  return fields;
}

function templateMeaning(template: TextTemplate): TextTemplate {
  const segments: TextTemplate["segments"] = [];
  for (const segment of template.segments) {
    if (segment.type === "literal") {
      if (!segment.value) continue;
      const previous = segments.at(-1);
      if (previous?.type === "literal") previous.value += segment.value;
      else segments.push({ type: "literal", value: segment.value });
    } else segments.push({ type: "variable", path: segment.path });
  }
  return { type: "topikTextTemplate", segments };
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}
