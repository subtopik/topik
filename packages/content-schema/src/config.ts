import Markdoc, {
  type Config,
  type Node,
  type Schema,
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
  const canonical: Config = cloneConfig(canonicalTopikMarkdocConfig);
  const nodes = additiveSchemas(extension.nodes, canonical.nodes);
  const tags = additiveSchemas(extension.tags, canonical.tags);
  const functions = additiveFunctions(extension.functions);
  return {
    ...canonical,
    nodes: registry(nodes, canonical.nodes),
    tags: registry(tags, canonical.tags),
    variables: cloneConfig(extension.variables ?? canonical.variables ?? {}),
    functions: registry(functions, canonical.functions),
    partials: registry(cloneConfig(extension.partials), canonical.partials),
    validation: registry(cloneConfig(extension.validation), canonical.validation),
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
  const attributes = schema.attributes;
  const isolatedAttributes = isolateSchemaAttributes(attributes);
  const replacements = new WeakMap<object, unknown>();
  rememberCloneReplacement(replacements, attributes, isolatedAttributes);
  const isolated = cloneConfig(schema, replacements);
  const transform = Reflect.get(schema, "transform") as Schema["transform"];
  const validate = Reflect.get(schema, "validate") as Schema["validate"];
  if (isolatedAttributes !== undefined) isolated.attributes = isolatedAttributes;
  if (typeof validate === "function") {
    isolated.validate = isolateSchemaValidate(validate);
  }
  if (typeof transform === "function") {
    isolated.transform = isolateSchemaTransform(transform);
  }
  return isolated;
}

function isolateSchemaAttributes(
  attributes: Schema["attributes"],
): Schema["attributes"] | undefined {
  if (attributes === undefined) return undefined;
  const isolated = registry<NonNullable<Schema["attributes"]>[string]>();
  for (const [name, attribute] of ownEntries(attributes)) {
    isolated[name] = isolateSchemaAttribute(attribute);
  }
  return isolated;
}

function isolateFunctionCallback(
  schema: NonNullable<Config["functions"]>[string],
): NonNullable<Config["functions"]>[string] {
  const parameters = schema.parameters;
  const isolatedParameters = isolateSchemaAttributes(parameters);
  const returns = readOptionalOwnType(schema, "returns");
  const isolatedReturns = returns.present ? isolateAttributeType(returns.value) : undefined;
  const replacements = new WeakMap<object, unknown>();
  rememberCloneReplacement(replacements, parameters, isolatedParameters);
  if (returns.present) rememberCloneReplacement(replacements, returns.value, isolatedReturns);
  const isolated = cloneConfig(schema, replacements);
  const transform = Reflect.get(schema, "transform") as typeof schema.transform;
  const validate = Reflect.get(schema, "validate") as typeof schema.validate;
  if (isolatedParameters !== undefined) isolated.parameters = isolatedParameters;
  if (returns.present) {
    isolated.returns = isolatedReturns as ValidationType | ValidationType[];
  }
  if (typeof validate === "function") {
    isolated.validate = isolateFunctionValidate(validate);
  }
  if (typeof transform === "function") {
    isolated.transform = isolateFunctionTransform(transform);
  }
  return isolated;
}

const isolatedSchemaTransforms = new WeakMap<Function, NonNullable<Schema["transform"]>>();
const isolatedSchemaValidators = new WeakMap<Function, NonNullable<Schema["validate"]>>();
const isolatedFunctionTransforms = new WeakMap<
  Function,
  NonNullable<NonNullable<Config["functions"]>[string]["transform"]>
>();
const isolatedFunctionValidators = new WeakMap<
  Function,
  NonNullable<NonNullable<Config["functions"]>[string]["validate"]>
>();
const isolatedAttributeValidators = new WeakMap<
  Function,
  NonNullable<NonNullable<Schema["attributes"]>[string]["validate"]>
>();
const isolatedAttributeMatches = new WeakMap<
  Function,
  Extract<NonNullable<NonNullable<Schema["attributes"]>[string]["matches"]>, Function>
>();

function isolateSchemaAttribute(
  attribute: NonNullable<Schema["attributes"]>[string],
): NonNullable<Schema["attributes"]>[string] {
  const type = readOptionalOwnType(attribute, "type");
  const isolatedType = type.present ? isolateAttributeType(type.value) : undefined;
  const replacements = new WeakMap<object, unknown>();
  if (type.present) rememberCloneReplacement(replacements, type.value, isolatedType);
  const isolated = cloneConfig(attribute, replacements);
  const matches = Reflect.get(attribute, "matches") as typeof attribute.matches;
  const validate = Reflect.get(attribute, "validate") as typeof attribute.validate;
  if (type.present) {
    isolated.type = isolatedType as ValidationType | ValidationType[];
  }
  if (typeof validate === "function") {
    isolated.validate = isolateAttributeValidate(validate);
  }
  if (typeof matches === "function") {
    isolated.matches = isolateAttributeMatchesCallback(matches);
  } else if (matches instanceof RegExp) {
    const { flags, source } = matches;
    isolated.matches = () => new RegExp(source, flags);
  }
  return isolated;
}

function isolateSchemaValidate(
  validate: NonNullable<Schema["validate"]>,
): NonNullable<Schema["validate"]> {
  const existing = isolatedSchemaValidators.get(validate);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<Schema["validate"]> = function (this: Schema, node, config) {
    return invokeIsolatedCallback(validate, this, [node, config]);
  };
  Object.freeze(isolated);
  isolatedSchemaValidators.set(validate, isolated);
  isolatedSchemaValidators.set(isolated, isolated);
  return isolated;
}

function isolateSchemaTransform(
  transform: NonNullable<Schema["transform"]>,
): NonNullable<Schema["transform"]> {
  const existing = isolatedSchemaTransforms.get(transform);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<Schema["transform"]> = function (this: Schema, node, config) {
    return invokeIsolatedCallback(transform, this, [node, config]);
  };
  Object.freeze(isolated);
  isolatedSchemaTransforms.set(transform, isolated);
  isolatedSchemaTransforms.set(isolated, isolated);
  return isolated;
}

function isolateFunctionValidate(
  validate: NonNullable<NonNullable<Config["functions"]>[string]["validate"]>,
): NonNullable<NonNullable<Config["functions"]>[string]["validate"]> {
  const existing = isolatedFunctionValidators.get(validate);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<NonNullable<Config["functions"]>[string]["validate"]> = function (
    this: NonNullable<Config["functions"]>[string],
    fn,
    config,
  ) {
    return invokeIsolatedCallback(validate, this, [fn, config]);
  };
  Object.freeze(isolated);
  isolatedFunctionValidators.set(validate, isolated);
  isolatedFunctionValidators.set(isolated, isolated);
  return isolated;
}

function isolateFunctionTransform(
  transform: NonNullable<NonNullable<Config["functions"]>[string]["transform"]>,
): NonNullable<NonNullable<Config["functions"]>[string]["transform"]> {
  const existing = isolatedFunctionTransforms.get(transform);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<NonNullable<Config["functions"]>[string]["transform"]> = function (
    this: NonNullable<Config["functions"]>[string],
    parameters,
    config,
  ) {
    return invokeIsolatedCallback(transform, this, [parameters, config]);
  };
  Object.freeze(isolated);
  isolatedFunctionTransforms.set(transform, isolated);
  isolatedFunctionTransforms.set(isolated, isolated);
  return isolated;
}

function isolateAttributeValidate(
  validate: NonNullable<NonNullable<Schema["attributes"]>[string]["validate"]>,
): NonNullable<NonNullable<Schema["attributes"]>[string]["validate"]> {
  const existing = isolatedAttributeValidators.get(validate);
  if (existing !== undefined) return existing;
  const isolated: NonNullable<NonNullable<Schema["attributes"]>[string]["validate"]> = function (
    this: NonNullable<Schema["attributes"]>[string],
    value,
    config,
    key,
  ) {
    return invokeIsolatedCallback(validate, this, [value, config, key]);
  };
  Object.freeze(isolated);
  isolatedAttributeValidators.set(validate, isolated);
  isolatedAttributeValidators.set(isolated, isolated);
  return isolated;
}

function isolateAttributeMatchesCallback(
  matches: Extract<NonNullable<NonNullable<Schema["attributes"]>[string]["matches"]>, Function>,
): Extract<NonNullable<NonNullable<Schema["attributes"]>[string]["matches"]>, Function> {
  const existing = isolatedAttributeMatches.get(matches);
  if (existing !== undefined) return existing;
  const isolated: Extract<
    NonNullable<NonNullable<Schema["attributes"]>[string]["matches"]>,
    Function
  > = function (this: NonNullable<Schema["attributes"]>[string], config: Config) {
    return invokeIsolatedCallback<ReturnType<typeof matches>>(matches, this, [config]);
  };
  Object.freeze(isolated);
  isolatedAttributeMatches.set(matches, isolated);
  isolatedAttributeMatches.set(isolated, isolated);
  return isolated;
}

function isolateAttributeType(type: unknown): NonNullable<Schema["attributes"]>[string]["type"] {
  try {
    return admitAttributeType(type, new WeakSet<object>()) as NonNullable<
      Schema["attributes"]
    >[string]["type"];
  } catch {
    throw unsupportedAttributeType();
  }
}

function admitAttributeType(type: unknown, activeArrays: WeakSet<object>): unknown {
  if (nativeAttributeTypes.has(type)) return type;
  if (nativeAttributeTypeNames.has(type)) return type;

  // A transparent Proxy<Array> is indistinguishable from its target in portable ECMAScript.
  // Descriptor-only traversal minimizes executable observation and no input array is retained.
  if (!Array.isArray(type)) throw unsupportedAttributeType();
  if (activeArrays.has(type)) throw unsupportedAttributeType();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(type, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > 0xffff_ffff
  ) {
    throw unsupportedAttributeType();
  }

  activeArrays.add(type);
  try {
    const admitted: ValidationType[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(type, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw unsupportedAttributeType();
      }
      admitted.push(admitAttributeType(descriptor.value, activeArrays) as ValidationType);
    }
    return admitted;
  } finally {
    activeArrays.delete(type);
  }
}

const nativeAttributeTypes = new Set<unknown>([String, Number, Boolean, Object, Array]);
const nativeAttributeTypeNames = new Set<unknown>([
  "String",
  "Number",
  "Boolean",
  "Object",
  "Array",
]);

type OptionalTypeProperty = { present: false } | { present: true; value: unknown };

function readOptionalOwnType(value: object, key: "returns" | "type"): OptionalTypeProperty {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined) {
    if (!("value" in descriptor)) throw unsupportedAttributeType();
    return { present: true, value: descriptor.value };
  }

  const visited = new Set<object>();
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype !== null) {
    if (visited.has(prototype)) throw unsupportedAttributeType();
    visited.add(prototype);
    if (Object.getOwnPropertyDescriptor(prototype, key) !== undefined) {
      throw unsupportedAttributeType();
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return { present: false };
}

function rememberCloneReplacement(
  replacements: WeakMap<object, unknown>,
  source: unknown,
  replacement: unknown,
): void {
  if (source !== null && (typeof source === "object" || typeof source === "function")) {
    replacements.set(source, replacement);
  }
}

function unsupportedAttributeType(): TypeError {
  return new TypeError("Unsupported attribute type configuration");
}

function invokeIsolatedCallback<TResult>(
  callback: CallableFunction,
  receiver: unknown,
  args: unknown[],
): TResult {
  const invocation = cloneConfig({ receiver, args });
  const result = Reflect.apply(callback, invocation.receiver, invocation.args) as TResult;
  if (consumePromiseLike(result)) {
    throw new TypeError("Asynchronous extension callbacks are unsupported");
  }
  return cloneConfig(result);
}

function consumePromiseLike(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  const then = stableCallbackResultProperty(value, "then");
  if (!then.found || typeof then.value !== "function") return false;
  void Promise.resolve(value as PromiseLike<unknown>).catch(() => undefined);
  return true;
}

function stableCallbackResultProperty(
  value: object,
  name: PropertyKey,
): { found: boolean; value?: unknown } {
  const visited = new Set<object>();
  let current: object | null = value;
  while (current !== null) {
    if (visited.has(current)) throw new TypeError("Unsupported callback result prototype");
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new TypeError("Unsupported callback result accessor");
      const observed = Reflect.get(value, name, value);
      if (observed !== descriptor.value) throw new TypeError("Unstable callback result");
      return { found: true, value: descriptor.value };
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  if (Reflect.get(value, name, value) !== undefined) {
    throw new TypeError("Dynamic callback result property");
  }
  return { found: false };
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
