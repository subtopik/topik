import type { AuthoredAttributeValue, Component, Scalar } from "./model.js";
import { accordionDefinition } from "./extensions/accordion.js";
import { badgeDefinition } from "./extensions/badge.js";
import { calloutDefinition } from "./extensions/callout.js";
import { cardDefinition, cardGridDefinition } from "./extensions/cards.js";
import { codeGroupDefinition, codeTabDefinition } from "./extensions/code.js";
import { figureDefinition } from "./extensions/figure.js";
import { mathDefinition, mathInlineDefinition } from "./extensions/math.js";
import { nativeComponents } from "./extensions/native.js";
import {
  choiceDefinition,
  explanationDefinition,
  questionDefinition,
  quizDefinition,
} from "./extensions/quiz.js";
import { stepDefinition, stepsDefinition } from "./extensions/steps.js";
import { tabDefinition, tabsDefinition } from "./extensions/tabs.js";
import { underlineDefinition } from "./extensions/underline.js";

export const TOPIK_CONTENT_SCHEMA_VERSION = "0.2.1";
export const CALLOUT_VARIANTS = ["info", "tip", "warning", "danger"] as const;
export const BADGE_VARIANTS = ["neutral", "info", "success", "warning", "danger"] as const;
export const QUIZ_QUESTION_TYPES = ["single-choice", "multiple-choice"] as const;

export type TopikAssetReferenceRole = "image" | "image-light" | "image-dark" | "media" | "download";
export interface TopikAssetReferenceDefinition {
  slot: string;
  role: TopikAssetReferenceRole;
  conditional?: "proven-download";
}

type AttributeOptions<T extends Scalar> = {
  required?: boolean;
  default?: T;
  description?: string;
  asset?: boolean;
  assetReference?: TopikAssetReferenceDefinition;
};

export type AttributeDefinition =
  | (AttributeOptions<string> & {
      type: "string";
      /** Canonical text slots alone admit explicit authored templates. */
      interpolation?: "text";
      values?: never;
      min?: never;
      max?: never;
    })
  | (AttributeOptions<string> & {
      type: "enum";
      values: readonly string[];
      min?: never;
      max?: never;
    })
  | (AttributeOptions<number> & {
      type: "number";
      min?: number;
      max?: number;
      integer?: boolean;
      values?: never;
    })
  | (AttributeOptions<boolean> & { type: "boolean"; values?: never; min?: never; max?: never });

export type ChildConstraint =
  | "blocks"
  | "inline"
  | "none"
  | { components: readonly string[]; min?: number }
  | { nodes: readonly string[]; min?: number };

export interface ValidationIssue {
  id: string;
  message: string;
}

/** Declarative schema accepted in application configuration. */
export interface ComponentSchema {
  kind: "block" | "inline";
  render: string | boolean;
  description?: string;
  attributes: Record<string, AttributeDefinition>;
  children: ChildConstraint;
  /** Allows an empty block body to use a self-closing source tag. */
  selfClosing?: boolean;
  allowedParents?: readonly string[];
}

/** Runtime definitions additionally carry the canonical catalog's semantic rules. */
export interface ComponentDefinition extends ComponentSchema {
  /** Only for rules depending on sibling properties, such as quiz answers. */
  validate?: (
    component: Component,
    effectiveProps: Record<string, AuthoredAttributeValue>,
  ) => ValidationIssue[];
}

export type Registry = Record<string, ComponentDefinition>;
export interface TopikComponentDefinition {
  name: string;
  kind: "block" | "inline";
  render: string;
  description: string;
  attributes?: Record<string, AttributeDefinition>;
  allowedChildren?: readonly string[];
  requiredChildren?: readonly string[];
}
export type TopikComponentAttributeDefinition = AttributeDefinition;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function textAttributes(
  definition: ComponentDefinition,
  names: readonly string[],
): ComponentDefinition {
  const attributes = { ...definition.attributes };
  for (const name of names) {
    const attribute = attributes[name];
    if (attribute.type !== "string" || attribute.asset || attribute.assetReference)
      throw new Error("Template slots must be plain string attributes");
    attributes[name] = { ...attribute, interpolation: "text" };
  }
  return { ...definition, attributes };
}

const authoredComponents = {
  accordion: textAttributes(accordionDefinition, ["title"]),
  badge: badgeDefinition,
  callout: textAttributes(calloutDefinition, ["title"]),
  card: textAttributes(cardDefinition, ["title"]),
  cardGrid: cardGridDefinition,
  codeGroup: codeGroupDefinition,
  codeTab: {
    ...textAttributes(codeTabDefinition, ["title"]),
    children: { nodes: ["code", "topikCodeTemplate"], min: 1 },
  },
  choice: choiceDefinition,
  explanation: explanationDefinition,
  figure: textAttributes(figureDefinition, ["alt", "caption"]),
  math: mathDefinition,
  mathInline: mathInlineDefinition,
  question: questionDefinition,
  quiz: quizDefinition,
  step: textAttributes(stepDefinition, ["title"]),
  steps: stepsDefinition,
  tab: textAttributes(tabDefinition, ["title"]),
  tabs: tabsDefinition,
  underline: underlineDefinition,
} satisfies Registry;

/** Canonical schemas are immutable; callers add custom names in a separate registry. */
export const components: Registry = deepFreeze({ ...authoredComponents, u: underlineDefinition });

function metadata(name: string, definition: ComponentDefinition): TopikComponentDefinition {
  const constraint = definition.children;
  const allowedChildren =
    typeof constraint === "object"
      ? "components" in constraint
        ? constraint.components
        : constraint.nodes.map((node) => (node === "code" ? "fence" : node))
      : undefined;
  const requiredChildren =
    name === "question"
      ? ["choice"]
      : typeof constraint === "object" && constraint.min
        ? allowedChildren?.slice(0, 1)
        : undefined;
  return {
    name,
    kind: definition.kind,
    render: String(definition.render),
    description: definition.description ?? "",
    ...(Object.keys(definition.attributes).length ? { attributes: definition.attributes } : {}),
    ...(allowedChildren ? { allowedChildren } : {}),
    ...(requiredChildren ? { requiredChildren } : {}),
  };
}

/** Legacy catalog metadata, derived from authored definitions plus native mdast nodes. */
export const topikComponents = deepFreeze({
  ...Object.fromEntries(
    Object.entries(authoredComponents).map(([name, definition]) => [
      name,
      metadata(name, definition),
    ]),
  ),
  ...nativeComponents,
}) as unknown as Record<
  keyof typeof authoredComponents | keyof typeof nativeComponents,
  TopikComponentDefinition
>;

export type TopikComponentName = keyof typeof topikComponents;

/** Defaults are for reading/rendering; authored absence stays unchanged. */
export function getEffectiveProps(
  component: Pick<Component, "name" | "props">,
  registry: Registry = components,
): Record<string, AuthoredAttributeValue> {
  const definition = Object.hasOwn(registry, component.name) ? registry[component.name] : undefined;
  if (!definition) throw new Error(`Unknown component ${component.name}`);
  const defaults: Record<string, Scalar> = {};
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    if (attribute.default !== undefined) defaults[name] = attribute.default;
  }
  return { ...defaults, ...component.props };
}
