import { components, type ComponentSchema, type Registry } from "./registry.js";
import { assertDataLimits } from "./limits.js";

export interface TopikContentConfig {
  /** Additional component schemas. Canonical Topik definitions cannot be replaced. */
  components?: Record<string, ComponentSchema>;
  /** Reader context used only by explicit evaluation or rendering. */
  variables?: Record<string, unknown>;
}

export interface ResolvedTopikContentConfig {
  components: Registry;
  variables: Record<string, unknown>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/** Configuration is developer-supplied; describe the failing field, never its value. */
function invalid(detail: string, cause?: unknown): Error {
  const bounded = detail.length > 300 ? `${detail.slice(0, 300)}...` : detail;
  return new Error(
    `Content configuration is invalid: ${bounded}`,
    cause === undefined ? undefined : { cause },
  );
}

/** Quote a configuration key for an error message, bounded for oversized input. */
function label(name: string): string {
  return JSON.stringify(name.length > 64 ? `${name.slice(0, 64)}...` : name);
}

function ownEntries(value: Record<string, unknown>, path: string): Array<[string, unknown]> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    throw invalid(`${path} must not have symbol keys`);
  return Object.entries(descriptors).map(([key, descriptor]) => {
    if (!("value" in descriptor)) throw invalid(`${path}.${key} must be a data property`);
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      throw invalid(`${path} must not use the reserved key ${label(key)}`);
    return [key, descriptor.value];
  });
}

function validName(name: string): boolean {
  return /^[a-z][A-Za-z0-9-]*$/.test(name);
}

function unknownField(
  value: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  return Object.keys(value).find((field) => !fields.includes(field));
}

function attributeProblem(attribute: unknown): string | undefined {
  if (!plainObject(attribute)) return "must be an object";
  // Template eligibility is owned by the canonical catalog, never custom schemas.
  if (Object.hasOwn(attribute, "interpolation"))
    return "cannot declare interpolation; text templates are limited to canonical attributes";
  const unknown = unknownField(attribute, [
    "type",
    "required",
    "default",
    "description",
    "values",
    "min",
    "max",
    "integer",
    "asset",
    "assetReference",
    "escapedWhitespace",
  ]);
  if (unknown !== undefined) return `has unsupported field ${label(unknown)}`;
  if (attribute.required !== undefined && typeof attribute.required !== "boolean")
    return "required must be a boolean";
  if (attribute.description !== undefined && typeof attribute.description !== "string")
    return "description must be a string";
  if (attribute.asset !== undefined && typeof attribute.asset !== "boolean")
    return "asset must be a boolean";
  if (
    attribute.escapedWhitespace !== undefined &&
    (attribute.type !== "string" || typeof attribute.escapedWhitespace !== "boolean")
  )
    return "escapedWhitespace must be a boolean on a string attribute";
  if (
    (attribute.asset || attribute.assetReference !== undefined) &&
    attribute.type !== "string" &&
    attribute.type !== "enum"
  )
    return "asset attributes must have type string or enum";
  if (attribute.assetReference !== undefined) {
    const reference = attribute.assetReference;
    if (
      !plainObject(reference) ||
      unknownField(reference, ["slot", "role", "conditional"]) !== undefined ||
      typeof reference.slot !== "string" ||
      !["image", "image-light", "image-dark", "video", "media", "download"].includes(
        String(reference.role),
      ) ||
      (reference.conditional !== undefined && reference.conditional !== "proven-download")
    )
      return "assetReference requires a string slot, a supported role and an optional proven-download condition";
  }
  const constraints = (allowed: readonly string[]): string | undefined => {
    const field = ["values", "min", "max", "integer"].find(
      (name) => !allowed.includes(name) && attribute[name] !== undefined,
    );
    return field === undefined
      ? undefined
      : `${field} is not supported on ${String(attribute.type)} attributes`;
  };
  if (attribute.type === "string")
    return (
      constraints([]) ??
      (attribute.default === undefined || typeof attribute.default === "string"
        ? undefined
        : "default must be a string")
    );
  if (attribute.type === "enum") {
    if (
      !Array.isArray(attribute.values) ||
      attribute.values.length === 0 ||
      !attribute.values.every((value) => typeof value === "string")
    )
      return "values must be a nonempty array of strings";
    return (
      constraints(["values"]) ??
      (attribute.default === undefined ||
      (typeof attribute.default === "string" && attribute.values.includes(attribute.default))
        ? undefined
        : "default must be one of values")
    );
  }
  if (attribute.type === "boolean")
    return (
      constraints([]) ??
      (attribute.default === undefined || typeof attribute.default === "boolean"
        ? undefined
        : "default must be a boolean")
    );
  if (attribute.type === "number") {
    const unsupported = constraints(["min", "max", "integer"]);
    if (unsupported) return unsupported;
    if (
      attribute.min !== undefined &&
      !(typeof attribute.min === "number" && Number.isFinite(attribute.min))
    )
      return "min must be a finite number";
    if (
      attribute.max !== undefined &&
      !(typeof attribute.max === "number" && Number.isFinite(attribute.max))
    )
      return "max must be a finite number";
    if (attribute.integer !== undefined && typeof attribute.integer !== "boolean")
      return "integer must be a boolean";
    if (
      attribute.min !== undefined &&
      attribute.max !== undefined &&
      (attribute.min as number) > (attribute.max as number)
    )
      return "min must not exceed max";
    if (
      attribute.default !== undefined &&
      !(
        typeof attribute.default === "number" &&
        Number.isFinite(attribute.default) &&
        (attribute.min === undefined || attribute.default >= (attribute.min as number)) &&
        (attribute.max === undefined || attribute.default <= (attribute.max as number)) &&
        (!attribute.integer || Number.isInteger(attribute.default))
      )
    )
      return "default must be a finite number within min, max and integer constraints";
    return;
  }
  return "type must be string, number, boolean or enum";
}

function definitionProblem(definition: unknown): string | undefined {
  if (!plainObject(definition)) return "must be an object";
  const unknown = unknownField(definition, [
    "kind",
    "render",
    "description",
    "attributes",
    "children",
    "selfClosing",
    "allowedParents",
  ]);
  if (unknown !== undefined) return `has unsupported field ${label(unknown)}`;
  if (definition.kind !== "block" && definition.kind !== "inline")
    return 'kind must be "block" or "inline"';
  if (typeof definition.render !== "string" && typeof definition.render !== "boolean")
    return "render must be a string or boolean";
  if (definition.description !== undefined && typeof definition.description !== "string")
    return "description must be a string";
  if (definition.selfClosing !== undefined && typeof definition.selfClosing !== "boolean")
    return "selfClosing must be a boolean";
  if (!plainObject(definition.attributes)) return "attributes must be an object";
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    if (!validName(name)) return `attribute ${label(name)} has an invalid name`;
    const problem = attributeProblem(attribute);
    if (problem) return `attribute ${label(name)} ${problem}`;
  }
  if (
    definition.allowedParents !== undefined &&
    (!Array.isArray(definition.allowedParents) ||
      !definition.allowedParents.every((name) => typeof name === "string" && validName(name)))
  )
    return "allowedParents must be an array of component names";
  const children = definition.children;
  if (children === "blocks" || children === "inline" || children === "none") return;
  if (!plainObject(children))
    return 'children must be "blocks", "inline", "none" or a child constraint object';
  const unknownChild = unknownField(children, ["components", "nodes", "min"]);
  if (unknownChild !== undefined) return `children has unsupported field ${label(unknownChild)}`;
  const names = children.components ?? children.nodes;
  if (
    (children.components === undefined) === (children.nodes === undefined) ||
    !Array.isArray(names) ||
    names.length === 0 ||
    !names.every((name) => typeof name === "string" && validName(name))
  )
    return "children requires exactly one nonempty components or nodes name array";
  if (
    children.min !== undefined &&
    !(typeof children.min === "number" && Number.isInteger(children.min) && children.min >= 0)
  )
    return "children.min must be a nonnegative integer";
}

/** Component references must name registered components, or the component is unplaceable. */
function referenceProblem(definition: ComponentSchema, registry: Registry): string | undefined {
  const parent = definition.allowedParents?.find((name) => !Object.hasOwn(registry, name));
  if (parent !== undefined) return `allowedParents names unknown component ${label(parent)}`;
  const constraint = definition.children;
  if (typeof constraint === "object" && "components" in constraint) {
    const child = constraint.components.find((name) => !Object.hasOwn(registry, name));
    if (child !== undefined) return `children.components names unknown component ${label(child)}`;
  }
}

function cloneSchema(value: unknown, path: string, active = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value !== "object")
    throw invalid(
      `${path} must contain only strings, finite numbers, booleans, null, arrays or plain objects`,
    );
  if (active.has(value)) throw invalid(`${path} must not be cyclic`);
  if (!Array.isArray(value) && !plainObject(value))
    throw invalid(`${path} must contain only arrays and plain objects`);
  active.add(value);
  let cloned: unknown;
  if (Array.isArray(value)) {
    const entries = ownEntries(value as unknown as Record<string, unknown>, path);
    if (
      entries.length !== value.length + 1 ||
      entries.some(([key], index) => index < value.length && key !== String(index))
    )
      throw invalid(`${path} must be a dense array without extra properties`);
    cloned = entries
      .slice(0, -1)
      .map(([key, entry]) => cloneSchema(entry, `${path}[${key}]`, active));
  } else {
    cloned = Object.fromEntries(
      ownEntries(value, path).map(([key, entry]) => [
        key,
        cloneSchema(entry, `${path}.${key}`, active),
      ]),
    );
  }
  active.delete(value);
  return cloned;
}

/** Isolate schemas before validation; runtime variables are read without invoking accessors. */
export function mergeTopikContentConfig(
  extension: TopikContentConfig = {},
): ResolvedTopikContentConfig {
  try {
    assertDataLimits(extension);
  } catch (error) {
    throw invalid("it exceeds the supported data limits", error);
  }
  if (!plainObject(extension)) throw invalid("it must be a plain object");
  const fields = Object.fromEntries(ownEntries(extension, "config"));
  const unknown = Object.keys(fields).find((key) => key !== "components" && key !== "variables");
  if (unknown !== undefined) throw invalid(`unsupported field ${label(unknown)}`);
  const additional = fields.components ?? {};
  const variables = fields.variables ?? {};
  if (!plainObject(additional)) throw invalid("components must be a plain object");
  if (!plainObject(variables)) throw invalid("variables must be a plain object");
  const registry: Registry = { ...components };
  const custom: string[] = [];
  for (const [name, schema] of ownEntries(additional, "components")) {
    // A previously resolved config may be passed back in. Always reapply the
    // canonical definitions instead of trusting caller modifications to them.
    if (Object.hasOwn(components, name)) continue;
    if (!validName(name)) throw invalid(`component ${label(name)} has an invalid name`);
    if (name === "if" || name === "else")
      throw invalid(`component ${label(name)} uses a reserved name`);
    if (!plainObject(schema)) throw invalid(`component ${label(name)} must be a plain object`);
    const definition = cloneSchema(schema, `components.${name}`);
    const problem = definitionProblem(definition);
    if (problem) throw invalid(`component ${label(name)} ${problem}`);
    registry[name] = definition as ComponentSchema;
    custom.push(name);
  }
  for (const name of custom) {
    const problem = referenceProblem(registry[name], registry);
    if (problem) throw invalid(`component ${label(name)} ${problem}`);
  }
  return {
    components: registry,
    variables: cloneSchema(variables, "variables") as Record<string, unknown>,
  };
}
