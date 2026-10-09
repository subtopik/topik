import type {
  Branch,
  AuthoredAttributeValue,
  Component,
  ContentDocument,
  Diagnostic,
  TreeNode,
  Variable,
} from "./model.js";
import { validPath, writeExpression } from "./expressions.js";
import {
  assertDataLimits,
  assertTreeLimits,
  ContentLimitError,
  ContentDataError,
  limitDiagnostic,
} from "./limits.js";
import { codeTemplateProblem, nodeShapeProblem, textTemplateProblem } from "./node-validation.js";
import { nodeTypes as allowed, isContentKind, isInlineParent } from "./node-grammar.js";
import {
  indexDocument,
  isReference,
  referenceSourceLabel,
  type DocumentIndex,
} from "./document-index.js";
import type { Association } from "mdast";
import {
  components,
  getEffectiveProps,
  type ChildConstraint,
  type Registry,
  type ValidationIssue,
} from "./registry.js";

export interface Tag {
  name: string;
  close: boolean;
  selfClosing: boolean;
  props: Record<string, AuthoredAttributeValue>;
}

function issue(id: string, message: string): ValidationIssue {
  return { id, message };
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Validate the literal source form and properties before tree-level checks. */
export function validateTag(
  tag: Tag,
  registry: Registry,
  templateData = new Set<object>(),
): ValidationIssue | undefined {
  const definition = Object.hasOwn(registry, tag.name) ? registry[tag.name] : undefined;
  if (!definition) return issue("tag-undefined", `Unknown component ${tag.name}`);
  if (tag.close) return;
  if (!tag.props || typeof tag.props !== "object" || Array.isArray(tag.props))
    return issue("attribute-type-invalid", `Invalid properties on ${tag.name}`);
  if (definition.kind === "inline" && tag.selfClosing && definition.children !== "none")
    return issue("topik-tag-children", `Inline component ${tag.name} requires content`);
  if (definition.kind === "inline" && !tag.selfClosing && definition.children === "none")
    return issue("topik-tag-children", `Inline component ${tag.name} must be self-closing`);
  if (
    definition.kind === "block" &&
    tag.selfClosing &&
    definition.children !== "none" &&
    !definition.selfClosing
  )
    return issue("topik-tag-children", `Block component ${tag.name} cannot be self-closing`);
  if (definition.kind === "block" && !tag.selfClosing && definition.children === "none")
    return issue("topik-tag-children", `Block component ${tag.name} must be self-closing`);

  for (const [key, value] of Object.entries(tag.props)) {
    const attr = Object.hasOwn(definition.attributes, key) ? definition.attributes[key] : undefined;
    if (!attr) return issue("attribute-undefined", `Unknown attribute ${key} on ${tag.name}`);
    if (value !== null && typeof value === "object" && value.type === "topikTextTemplate") {
      const canonicalDefinition = Object.hasOwn(components, tag.name)
        ? components[tag.name]
        : undefined;
      const canonical = canonicalDefinition?.attributes[key];
      if (
        definition.kind !== canonicalDefinition?.kind ||
        attr.type !== "string" ||
        attr.interpolation !== "text" ||
        attr.asset ||
        attr.assetReference ||
        canonical?.type !== "string" ||
        canonical.interpolation !== "text"
      )
        return issue("topik-template-location", `Attribute ${key} on ${tag.name} is literal-only`);
      const invalid = textTemplateProblem(value, false, templateData);
      if (invalid) return invalid;
      continue;
    }
    if (typeof value !== (attr.type === "enum" ? "string" : attr.type))
      return issue(
        "attribute-type-invalid",
        `Attribute ${key} on ${tag.name} must be a ${attr.type === "enum" ? "string" : attr.type}`,
      );
    if (typeof value === "string" && hasControl(value))
      return issue("attribute-value-invalid", `Control character in ${key} on ${tag.name}`);
    if (attr.type === "enum" && !attr.values.includes(value as string))
      return issue("attribute-value-invalid", `Invalid ${key} on ${tag.name}`);
    if (attr.type === "number") {
      const numeric = value as number;
      if (!Number.isFinite(numeric))
        return issue("attribute-value-invalid", `Invalid ${key} on ${tag.name}`);
      if (
        (attr.integer && !Number.isInteger(numeric)) ||
        (attr.min !== undefined && numeric < attr.min) ||
        (attr.max !== undefined && numeric > attr.max)
      )
        return issue(`topik-${kebab(key)}-range`, `Invalid ${key} on ${tag.name}`);
    }
  }
  for (const [key, attr] of Object.entries(definition.attributes)) {
    if (attr.required && !Object.hasOwn(tag.props, key))
      return issue("attribute-missing-required", `Missing attribute ${key} on ${tag.name}`);
  }
}

export function diagnostic(
  problem: string | ValidationIssue,
  marker?: TreeNode,
  id?: string,
): Diagnostic {
  return {
    ...(typeof problem === "string" ? { message: problem, ...(id ? { id } : {}) } : problem),
    line: marker?.position?.start?.line,
    column: marker?.position?.start?.column,
  };
}

function matchesConstraint(child: TreeNode, constraint: Exclude<ChildConstraint, string>): boolean {
  if ("components" in constraint)
    return (
      child.type === "topikComponent" && constraint.components.includes((child as Component).name)
    );
  return constraint.nodes.includes(child.type);
}

function validateChildren(component: Component, registry: Registry): ValidationIssue[] {
  const constraint = registry[component.name]?.children;
  if (!constraint) return [];
  const children = component.children;
  const name = component.name;
  if (constraint === "none")
    return children.length
      ? [issue(`topik-${kebab(name)}-children`, `${name} cannot contain children`)]
      : [];
  if (constraint === "blocks")
    return children.some((child) => !isContentKind(child, "block", registry))
      ? [issue(`topik-${kebab(name)}-children`, `${name} may contain only block children`)]
      : [];
  if (constraint === "inline") {
    if (!children.length)
      return [issue(`topik-${kebab(name)}-children`, `${name} requires inline children`)];
    return children.some((child) => !isContentKind(child, "inline", registry))
      ? [issue(`topik-${kebab(name)}-children`, `${name} may contain only inline children`)]
      : [];
  }
  const errors: ValidationIssue[] = [];
  if (children.some((child) => !matchesConstraint(child, constraint)))
    errors.push(
      issue(
        `topik-${kebab(name)}-children`,
        `${name} may contain only ${("components" in constraint ? constraint.components : constraint.nodes).join(", ")} children`,
      ),
    );
  if (children.length < (constraint.min ?? 0)) {
    const required =
      "components" in constraint
        ? constraint.components[0]
        : constraint.nodes[0] === "code"
          ? "fence"
          : constraint.nodes[0];
    errors.push(
      issue(
        `topik-${kebab(name)}-requires-${kebab(required)}`,
        `${name} requires at least one ${required} child`,
      ),
    );
  }
  return errors;
}

function validatePlacement(
  component: Component,
  parent: TreeNode | undefined,
  registry: Registry,
): ValidationIssue[] {
  const definition = registry[component.name];
  if (!definition) return [];
  const errors: ValidationIssue[] = [];
  if (
    definition.allowedParents &&
    !(
      parent?.type === "topikComponent" &&
      definition.allowedParents.includes((parent as Component).name)
    )
  ) {
    const required = definition.allowedParents[0];
    errors.push(
      issue(
        `topik-${kebab(required)}-parent-required`,
        `${component.name} must be inside ${definition.allowedParents.join(", ")}`,
      ),
    );
  }
  if (!parent) return errors;
  const parentIsInline = isInlineParent(parent, registry);
  if (definition.kind === "block" && parentIsInline)
    errors.push(issue("topik-tag-placement", `Block ${component.name} has invalid placement`));
  if (definition.kind === "inline" && !parentIsInline)
    errors.push(issue("topik-tag-placement", `Inline ${component.name} has invalid placement`));
  return errors;
}

export function validateDocument(
  document: ContentDocument,
  registry: Registry = components,
): Diagnostic[] {
  return validateDocumentWithIndex(document, registry).diagnostics;
}

/** @internal Keep the reference index available to the source admission pipeline. */
export function validateDocumentWithIndex(
  document: ContentDocument,
  registry: Registry,
): { diagnostics: Diagnostic[]; index?: DocumentIndex } {
  try {
    assertDataLimits(document, { plain: true });
    assertTreeLimits(document as TreeNode);
  } catch (error) {
    if (error instanceof ContentLimitError) return { diagnostics: [limitDiagnostic(error)] };
    if (error instanceof ContentDataError)
      return { diagnostics: [{ id: error.id, message: error.message }] };
    throw error;
  }
  const errors: Diagnostic[] = [];
  const templateData = new Set<object>();
  function add(problem: string | ValidationIssue, node: TreeNode, id?: string): void {
    errors.push(diagnostic(problem, node, id));
  }
  if (document?.type !== "root")
    return {
      diagnostics: [{ id: "topik-node-invalid", message: "Content documents require a root node" }],
    };
  function walk(
    node: TreeNode,
    parent?: TreeNode,
    insideLink = false,
    marks: Readonly<Record<"emphasis" | "strong" | "delete", number>> = {
      emphasis: 0,
      strong: 0,
      delete: 0,
    },
  ): void {
    const shapeProblem = nodeShapeProblem(node, registry);
    if (shapeProblem) {
      add(shapeProblem, node, "topik-node-invalid");
      return;
    }
    if (!allowed.has(node.type))
      add(`Unsupported Markdown node ${node.type}`, node, "node-undefined");
    if (node.type === "emphasis" || node.type === "strong" || node.type === "delete")
      marks = { ...marks, [node.type]: marks[node.type] + 1 };
    // Deeper repeated marks can be parsed, but their delimiters cannot reliably
    // be serialized beside links. Refuse rather than silently flattening them.
    if (marks.emphasis > 2 || marks.strong > 2 || marks.delete > 1) {
      add(
        marks.delete > 1
          ? "Strikethrough marks cannot be nested"
          : "Emphasis and strong marks support at most two nesting levels per kind",
        node,
        "topik-mark-nesting",
      );
      return;
    }
    if (node.type === "root" && parent)
      add("Root nodes cannot be nested", node, "topik-node-invalid");
    const link = node.type === "link" || node.type === "linkReference";
    if (link && insideLink) add("Links cannot contain other links", node, "topik-node-invalid");
    if (node.type === "yaml" && (parent?.type !== "root" || parent.children?.[0] !== node))
      add("YAML frontmatter must be the first root child", node, "topik-frontmatter-placement");
    if (node.type === "paragraph" && !node.children?.length)
      add(
        "Empty paragraphs have no faithful Markdown representation",
        node,
        "topik-empty-paragraph",
      );
    if (node.type === "topikVariable") {
      if (!validPath((node as TreeNode & Variable).path as string[]))
        add("Invalid variable path", node, "topik-variable-path");
      if (!parent || !isInlineParent(parent, registry))
        add("Variable has invalid placement", node, "topik-variable-placement");
    }
    if (node.type === "topikCodeTemplate") {
      const invalid = codeTemplateProblem(node, templateData);
      if (invalid) add(invalid, node);
    }
    if (node.type === "topikConditional") {
      const branches = node.children ?? [];
      if (
        !parent ||
        !(
          parent.type === "root" ||
          parent.type === "blockquote" ||
          parent.type === "listItem" ||
          parent.type === "topikBranch" ||
          (parent.type === "topikComponent" &&
            registry[(parent as Component).name]?.children === "blocks")
        )
      )
        add("Conditional has invalid block placement", node, "topik-conditional-placement");
      if (
        branches.length < 1 ||
        branches.length > 2 ||
        branches[0]?.type !== "topikBranch" ||
        branches[0]?.condition == null ||
        (branches[1] && (branches[1].type !== "topikBranch" || branches[1].condition !== null))
      )
        add("Invalid conditional branches", node, "topik-conditional-branches");
    }
    if (node.type === "topikBranch") {
      if (parent?.type !== "topikConditional")
        add("Branch must be inside a conditional", node, "topik-conditional-branches");
      const branch = node as TreeNode & Branch;
      if (branch.condition !== null) {
        try {
          writeExpression(branch.condition);
        } catch (error) {
          add(
            (error as Error).message,
            node,
            error instanceof ContentLimitError ? error.id : "topik-expression-invalid",
          );
        }
      }
      if ((node.children ?? []).some((child) => !isContentKind(child, "block", registry)))
        add(
          "Conditional branches may contain only block children",
          node,
          "topik-conditional-children",
        );
    }
    const errorsBeforeChildren = errors.length;
    for (const child of node.children ?? []) walk(child, node, insideLink || link, marks);
    const childrenValid = errors.length === errorsBeforeChildren;
    if (node.type === "topikComponent") {
      const component = node as TreeNode & Component;
      const invalid = validateTag(
        {
          name: component.name,
          close: false,
          selfClosing: registry[component.name]?.children === "none",
          props: component.props,
        },
        registry,
        templateData,
      );
      if (invalid) add(invalid, node);
      for (const problem of [
        ...validateChildren(component, registry),
        ...validatePlacement(component, parent, registry),
      ])
        add(problem, node);
      const definition = registry[component.name];
      if (definition?.validate && !invalid && childrenValid)
        for (const problem of definition.validate(
          component,
          getEffectiveProps(component, registry),
        ))
          add(problem, node);
    }
  }
  walk(document as TreeNode);
  let index: DocumentIndex | undefined;
  if (errors.length === 0) {
    index = indexDocument(document);
    for (const { node } of index.entries) {
      if (isReference(node)) {
        if (!index.resolve(node))
          add(
            "Reference has no definition in its conditional scope",
            node,
            "topik-reference-missing",
          );
      }
      if (isReference(node) || node.type === "definition") {
        const association = node as unknown as Association;
        const label = referenceSourceLabel(association);
        if (!label || label.length > 999 || !/^(?:\\[\s\S]|[^[\]\\])+$/u.test(label))
          add("Reference identifier has no faithful Markdown label", node, "topik-reference-label");
      }
    }
  }
  return { diagnostics: errors, index };
}
