import Markdoc, {
  type Config,
  type CustomAttributeType,
  type Node,
  type Scalar,
  type Schema,
  type ValidationError,
  type ValidationType,
} from "@markdoc/markdoc";
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
  nodes: registry(topikNodeSchemas),
  tags: registry({
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
  }),
  validation: registry({
    validateFunctions: true,
  }),
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
  const nodes = additiveSchemas(isolatedExtension.nodes, canonical.nodes);
  const tags = additiveSchemas(isolatedExtension.tags, canonical.tags);
  const functions = additiveFunctions(isolatedExtension.functions);
  return {
    ...isolatedExtension,
    ...canonical,
    nodes: registry(nodes, canonical.nodes),
    tags: registry(tags, canonical.tags),
    variables: cloneConfig(isolatedExtension.variables ?? canonical.variables ?? {}),
    functions: registry(functions, canonical.functions),
    partials: registry(isolatedExtension.partials, canonical.partials),
    validation: registry(isolatedExtension.validation, canonical.validation),
  };
}

/** @internal Recognition-only config for canonical validation before extension callbacks run. */
export function canonicalTopikValidationConfig(content: Node, extension: Config = {}): Config {
  const canonical: Config = cloneConfig(canonicalTopikMarkdocConfig);
  return {
    ...canonical,
    nodes: registry(
      passiveExtensionSchemas(content, extension.nodes, canonical.nodes, Markdoc.nodes, false),
      canonical.nodes,
    ),
    tags: registry(
      passiveExtensionSchemas(content, extension.tags, canonical.tags, Markdoc.tags, true),
      canonical.tags,
    ),
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
  if (extensions === undefined) return registry();
  const additiveNames = new Set(
    Object.keys(extensions).filter(
      (name) => !Object.hasOwn(canonical ?? {}, name) && !Object.hasOwn(builtIn ?? {}, name),
    ),
  );
  const schemas = registry<Schema>();
  for (const node of [content, ...content.walk()]) {
    const name = tags ? node.tag : node.type;
    if (name === undefined || !additiveNames.has(name)) continue;
    if (!Object.hasOwn(schemas, name)) schemas[name] = {};
    const schema = schemas[name];
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
  if (functions === undefined) return registry();
  const passive = registry<NonNullable<Config["functions"]>[string]>();
  for (const name of Object.keys(functions)) {
    if (!Object.hasOwn(Markdoc.functions, name)) passive[name] = {};
  }
  return passive;
}

function passiveExtensionPartials(partials: Config["partials"]): NonNullable<Config["partials"]> {
  if (partials === undefined) return registry();
  const passive = registry<NonNullable<Config["partials"]>[string]>();
  for (const name of Object.keys(partials)) passive[name] = true;
  return passive;
}

function passiveVariables(variables: Config["variables"]): NonNullable<Config["variables"]> {
  return variables === undefined ? registry() : cloneConfig(variables);
}

function additiveSchemas(
  extensions: Config["nodes"] | Config["tags"],
  canonical: Config["nodes"] | Config["tags"],
): Record<string, Schema> {
  const additive = registry<Schema>();
  for (const [name, schema] of ownEntries(extensions)) {
    if (Object.hasOwn(canonical ?? {}, name)) continue;
    additive[name] = isolateSchemaCallbacks(schema);
  }
  return additive;
}

function additiveFunctions(functions: Config["functions"]): NonNullable<Config["functions"]> {
  const additive = registry<NonNullable<Config["functions"]>[string]>();
  for (const [name, schema] of ownEntries(functions)) {
    additive[name] = isolateFunctionCallback(schema);
  }
  return additive;
}

function isolateSchemaCallbacks(schema: Schema): Schema {
  const isolated = cloneConfig(schema);
  if (typeof schema.transform === "function") {
    isolated.transform = isolateSchemaTransform(schema.transform.bind(schema));
  }
  for (const attribute of Object.values(isolated.attributes ?? {})) {
    attribute.type = isolateAttributeType(attribute.type);
  }
  return isolated;
}

function isolateFunctionCallback(
  schema: NonNullable<Config["functions"]>[string],
): NonNullable<Config["functions"]>[string] {
  const isolated = cloneConfig(schema);
  if (typeof schema.transform === "function") {
    isolated.transform = isolateFunctionTransform(schema.transform.bind(schema));
  }
  return isolated;
}

const isolatedSchemaTransforms = new WeakMap<Function, NonNullable<Schema["transform"]>>();
const isolatedFunctionTransforms = new WeakMap<
  Function,
  NonNullable<NonNullable<Config["functions"]>[string]["transform"]>
>();
const isolatedAttributeTypes = new WeakMap<Function, ValidationType>();

function isolateSchemaTransform(
  transform: NonNullable<Schema["transform"]>,
): NonNullable<Schema["transform"]> {
  const existing = isolatedSchemaTransforms.get(transform);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<Schema["transform"]> = (node, config) =>
    cloneConfig(transform(cloneConfig(node), cloneConfig(config)));
  isolatedSchemaTransforms.set(transform, isolated);
  isolatedSchemaTransforms.set(isolated, isolated);
  return isolated;
}

function isolateFunctionTransform(
  transform: NonNullable<NonNullable<Config["functions"]>[string]["transform"]>,
): NonNullable<NonNullable<Config["functions"]>[string]["transform"]> {
  const existing = isolatedFunctionTransforms.get(transform);
  if (existing !== undefined) return existing;
  const isolated = (parameters: Record<string, unknown>, config: Config) =>
    cloneConfig(transform(cloneConfig(parameters), cloneConfig(config)));
  isolatedFunctionTransforms.set(transform, isolated);
  isolatedFunctionTransforms.set(isolated, isolated);
  return isolated;
}

function isolateAttributeType(
  type: NonNullable<Schema["attributes"]>[string]["type"],
): NonNullable<Schema["attributes"]>[string]["type"] {
  if (Array.isArray(type)) {
    return type.map((entry) => isolateAttributeType(entry) as ValidationType);
  }
  if (typeof type !== "function") return type;
  const prototype = type.prototype as { transform?: unknown } | undefined;
  if (typeof prototype?.transform !== "function") return type;
  const existing = isolatedAttributeTypes.get(type);
  if (existing !== undefined) return existing;
  const Original = type as CustomAttributeType;
  class IsolatedAttributeType {
    validate(value: unknown, config: Config, key: string): ValidationError[] {
      const instance = new Original();
      return typeof instance.validate === "function"
        ? instance.validate(cloneConfig(value), cloneConfig(config), key)
        : [];
    }

    transform(value: unknown, config: Config): Scalar {
      const instance = new Original();
      return cloneConfig(instance.transform?.(cloneConfig(value), cloneConfig(config))) as Scalar;
    }
  }
  isolatedAttributeTypes.set(type, IsolatedAttributeType);
  isolatedAttributeTypes.set(IsolatedAttributeType, IsolatedAttributeType);
  return IsolatedAttributeType;
}

function ownEntries<T>(value: Record<string, T> | undefined): Array<[string, T]> {
  if (value === undefined) return [];
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("Invalid configuration registry");
  }
  return Object.keys(value).map((name) => [name, value[name]]);
}

function registry<T>(...sources: Array<Record<string, T> | undefined>): Record<string, T> {
  const output = Object.create(null) as Record<string, T>;
  for (const source of sources) {
    for (const [name, value] of ownEntries(source)) output[name] = value;
  }
  return output;
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

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    seen.set(value, clone);
    return clone as T;
  }

  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, nested] of value) {
      clone.set(cloneConfig(key, seen), cloneConfig(nested, seen));
    }
    return clone as T;
  }

  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const nested of value) clone.add(cloneConfig(nested, seen));
    return clone as T;
  }

  if (value instanceof URL) {
    const clone = new URL(value.href);
    seen.set(value, clone);
    return clone as T;
  }

  if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
    throw new TypeError("Unsupported configuration value");
  }

  if (value instanceof Markdoc.Tag) {
    const clone = new Markdoc.Tag(value.name, {}, []);
    seen.set(value, clone);
    clone.attributes = cloneConfig(value.attributes, seen);
    clone.children = cloneConfig(value.children, seen);
    return clone as T;
  }

  const prototype = Object.getPrototypeOf(value);
  const clonePrototype =
    prototype === null || prototype === Object.prototype ? prototype : cloneConfig(prototype, seen);
  const clone = Object.create(clonePrototype) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) throw new TypeError("Unsupported configuration accessor");
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      value: cloneConfig(descriptor.value, seen),
      writable: true,
    });
  }
  return clone as T;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
