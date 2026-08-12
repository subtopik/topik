import Markdoc, { type Config, type Node, type Schema } from "@markdoc/markdoc";
import { calloutTag } from "./tags/callout";
import { cardGridTag, cardTag } from "./tags/cards";
import { codeGroupTag, codeTabTag } from "./tags/code";
import { accordionTag } from "./tags/disclosure";
import { badgeTag, underlineTag } from "./tags/inline";
import { mathInlineTag, mathTag } from "./tags/math";
import { figureTag } from "./tags/media";
import { choiceTag, explanationTag, questionTag, quizTag } from "./tags/quiz";
import { stepTag, stepsTag } from "./tags/steps";
import { tabTag, tabsTag } from "./tags/tabs";
import { topikNodeSchemas } from "./nodes";

const canonicalTopikMarkdocConfig = deepFreeze({
  nodes: topikNodeSchemas,
  tags: {
    accordion: accordionTag,
    badge: badgeTag,
    callout: calloutTag,
    card: cardTag,
    cardGrid: cardGridTag,
    codeGroup: codeGroupTag,
    codeTab: codeTabTag,
    choice: choiceTag,
    explanation: explanationTag,
    figure: figureTag,
    math: mathTag,
    mathInline: mathInlineTag,
    question: questionTag,
    quiz: quizTag,
    step: stepTag,
    steps: stepsTag,
    tab: tabTag,
    tabs: tabsTag,
    u: underlineTag,
    underline: underlineTag,
  },
  validation: {
    validateFunctions: true,
  },
} satisfies Config);

/** Immutable public snapshot. Normal APIs use a separate private canonical authority. */
export const topikMarkdocConfig = deepFreeze(cloneConfig(canonicalTopikMarkdocConfig));

/**
 * Extend Topik's Markdoc environment without replacing canonical node or tag schemas.
 * Canonical validation always wins on normal source APIs.
 */
export function mergeTopikMarkdocConfig(extension: Config = {}): Config {
  const isolatedExtension: Config = cloneConfig(extension);
  const canonical: Config = cloneConfig(canonicalTopikMarkdocConfig);
  return {
    ...isolatedExtension,
    ...canonical,
    nodes: { ...isolatedExtension.nodes, ...canonical.nodes },
    tags: { ...isolatedExtension.tags, ...canonical.tags },
    variables: { ...isolatedExtension.variables, ...canonical.variables },
    functions: { ...isolatedExtension.functions, ...canonical.functions },
    partials: { ...isolatedExtension.partials, ...canonical.partials },
    validation: { ...isolatedExtension.validation, ...canonical.validation },
  };
}

/** @internal Recognition-only config for canonical validation before extension callbacks run. */
export function canonicalTopikValidationConfig(content: Node, extension: Config = {}): Config {
  const canonical: Config = cloneConfig(canonicalTopikMarkdocConfig);
  return {
    ...canonical,
    nodes: {
      ...passiveExtensionSchemas(content, extension.nodes, canonical.nodes, Markdoc.nodes, false),
      ...canonical.nodes,
    },
    tags: {
      ...passiveExtensionSchemas(content, extension.tags, canonical.tags, Markdoc.tags, true),
      ...canonical.tags,
    },
    variables: passiveVariables(extension.variables),
    functions: passiveExtensionFunctions(extension.functions),
    partials: passiveExtensionPartials(extension.partials),
  };
}

/** @internal Clone untrusted Markdoc data before a callback-controlled phase. */
export function isolateTopikMarkdocValue<T>(value: T): T {
  return cloneConfig(value);
}

function passiveExtensionSchemas(
  content: Node,
  extensions: Config["nodes"] | Config["tags"],
  canonical: Config["nodes"] | Config["tags"],
  builtIn: Config["nodes"] | Config["tags"],
  tags: boolean,
): Record<string, Schema> {
  if (extensions === undefined) return {};
  const additiveNames = new Set(
    Object.keys(extensions).filter(
      (name) => !Object.hasOwn(canonical ?? {}, name) && !Object.hasOwn(builtIn ?? {}, name),
    ),
  );
  const schemas: Record<string, Schema> = {};
  for (const node of [content, ...content.walk()]) {
    const name = tags ? node.tag : node.type;
    if (name === undefined || !additiveNames.has(name)) continue;
    const schema = (schemas[name] ??= {});
    schema.attributes = {
      ...schema.attributes,
      ...Object.fromEntries(Object.keys(node.attributes).map((key) => [key, {}])),
    };
    schema.slots = {
      ...schema.slots,
      ...Object.fromEntries(Object.keys(node.slots).map((key) => [key, {}])),
    };
  }
  return schemas;
}

function passiveExtensionFunctions(
  functions: Config["functions"],
): NonNullable<Config["functions"]> {
  if (functions === undefined) return {};
  return Object.fromEntries(
    Object.keys(functions)
      .filter((name) => !Object.hasOwn(Markdoc.functions, name))
      .map((name) => [name, {}]),
  );
}

function passiveExtensionPartials(partials: Config["partials"]): NonNullable<Config["partials"]> {
  if (partials === undefined) return {};
  return Object.fromEntries(Object.keys(partials).map((name) => [name, true]));
}

function passiveVariables(variables: Config["variables"]): NonNullable<Config["variables"]> {
  return variables === undefined ? {} : cloneConfig(variables);
}

/** Clone config and AST data while retaining validator/transform function identities. */
function cloneConfig<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const nested of value) clone.push(cloneConfig(nested, seen));
    return clone as T;
  }

  if (value instanceof Markdoc.Ast.Node) {
    const clone = new Markdoc.Ast.Node(value.type, {}, [], value.tag);
    seen.set(value, clone);
    clone.attributes = cloneConfig(value.attributes, seen);
    clone.slots = cloneConfig(value.slots, seen);
    clone.children = cloneConfig(value.children, seen);
    clone.errors = cloneConfig(value.errors, seen);
    clone.lines = cloneConfig(value.lines, seen);
    clone.annotations = cloneConfig(value.annotations, seen);
    clone.inline = value.inline;
    clone.location = cloneConfig(value.location, seen);
    return clone as T;
  }

  if (Markdoc.Ast.isVariable(value)) {
    const clone = new Markdoc.Ast.Variable();
    seen.set(value, clone);
    clone.path = cloneConfig(value.path, seen);
    return clone as T;
  }

  if (Markdoc.Ast.isFunction(value)) {
    const clone = new Markdoc.Ast.Function(value.name, {});
    seen.set(value, clone);
    clone.parameters = cloneConfig(value.parameters, seen);
    return clone as T;
  }

  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    seen.set(value, clone);
    return clone as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, nested] of Object.entries(value)) clone[key] = cloneConfig(nested, seen);
  return clone as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
