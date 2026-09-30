import {
  components,
  type AttributeDefinition,
  type ComponentSchema,
  type Registry,
} from "./registry.js";
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

function ownEntries(value: Record<string, unknown>): Array<[string, unknown]> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol"))
    throw new Error("Content configuration is invalid");
  return Object.entries(descriptors).map(([key, descriptor]) => {
    if (
      !("value" in descriptor) ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    )
      throw new Error("Content configuration is invalid");
    return [key, descriptor.value];
  });
}

function validName(name: string): boolean {
  return /^[a-z][A-Za-z0-9-]*$/.test(name);
}

function allowedFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field));
}

function validAttribute(attribute: unknown): attribute is AttributeDefinition {
  if (
    !plainObject(attribute) ||
    !allowedFields(attribute, [
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
    ])
  )
    return false;
  if (attribute.required !== undefined && typeof attribute.required !== "boolean") return false;
  if (attribute.description !== undefined && typeof attribute.description !== "string")
    return false;
  if (attribute.asset !== undefined && typeof attribute.asset !== "boolean") return false;
  if (
    (attribute.asset || attribute.assetReference !== undefined) &&
    attribute.type !== "string" &&
    attribute.type !== "enum"
  )
    return false;
  if (attribute.assetReference !== undefined) {
    const reference = attribute.assetReference;
    if (
      !plainObject(reference) ||
      !allowedFields(reference, ["slot", "role", "conditional"]) ||
      typeof reference.slot !== "string" ||
      !["image", "image-light", "image-dark", "media", "download"].includes(
        String(reference.role),
      ) ||
      (reference.conditional !== undefined && reference.conditional !== "proven-download")
    )
      return false;
  }
  if (attribute.type === "string")
    return (
      attribute.values === undefined &&
      attribute.min === undefined &&
      attribute.max === undefined &&
      attribute.integer === undefined &&
      (attribute.default === undefined || typeof attribute.default === "string")
    );
  if (attribute.type === "enum")
    return (
      Array.isArray(attribute.values) &&
      attribute.values.length > 0 &&
      attribute.values.every((value) => typeof value === "string") &&
      attribute.min === undefined &&
      attribute.max === undefined &&
      attribute.integer === undefined &&
      (attribute.default === undefined ||
        (typeof attribute.default === "string" && attribute.values.includes(attribute.default)))
    );
  if (attribute.type === "boolean")
    return (
      attribute.values === undefined &&
      attribute.min === undefined &&
      attribute.max === undefined &&
      attribute.integer === undefined &&
      (attribute.default === undefined || typeof attribute.default === "boolean")
    );
  if (attribute.type === "number")
    return (
      attribute.values === undefined &&
      (attribute.min === undefined ||
        (typeof attribute.min === "number" && Number.isFinite(attribute.min))) &&
      (attribute.max === undefined ||
        (typeof attribute.max === "number" && Number.isFinite(attribute.max))) &&
      (attribute.integer === undefined || typeof attribute.integer === "boolean") &&
      (attribute.default === undefined ||
        (typeof attribute.default === "number" &&
          Number.isFinite(attribute.default) &&
          (attribute.min === undefined || attribute.default >= attribute.min) &&
          (attribute.max === undefined || attribute.default <= attribute.max) &&
          (!attribute.integer || Number.isInteger(attribute.default)))) &&
      (attribute.min === undefined || attribute.max === undefined || attribute.min <= attribute.max)
    );
  return false;
}

function validDefinition(definition: unknown): definition is ComponentSchema {
  if (
    !plainObject(definition) ||
    !allowedFields(definition, [
      "kind",
      "render",
      "description",
      "attributes",
      "children",
      "selfClosing",
      "allowedParents",
    ])
  )
    return false;
  if (
    (definition.kind !== "block" && definition.kind !== "inline") ||
    (typeof definition.render !== "string" && typeof definition.render !== "boolean") ||
    (definition.description !== undefined && typeof definition.description !== "string") ||
    (definition.selfClosing !== undefined && typeof definition.selfClosing !== "boolean") ||
    !plainObject(definition.attributes)
  )
    return false;
  if (
    Object.entries(definition.attributes).some(
      ([name, attribute]) => !validName(name) || !validAttribute(attribute),
    )
  )
    return false;
  if (
    definition.allowedParents !== undefined &&
    (!Array.isArray(definition.allowedParents) ||
      !definition.allowedParents.every((name) => typeof name === "string" && validName(name)))
  )
    return false;
  const children = definition.children;
  if (children === "blocks" || children === "inline" || children === "none") return true;
  if (!plainObject(children) || !allowedFields(children, ["components", "nodes", "min"]))
    return false;
  const names = children.components ?? children.nodes;
  return (
    (children.components === undefined) !== (children.nodes === undefined) &&
    Array.isArray(names) &&
    names.length > 0 &&
    names.every((name) => typeof name === "string" && validName(name)) &&
    (children.min === undefined ||
      (typeof children.min === "number" && Number.isInteger(children.min) && children.min >= 0))
  );
}

function cloneSchema(value: unknown, active = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value !== "object") throw new Error("Content configuration is invalid");
  if (active.has(value) || (!Array.isArray(value) && !plainObject(value)))
    throw new Error("Content configuration is invalid");
  active.add(value);
  let cloned: unknown;
  if (Array.isArray(value)) {
    const entries = ownEntries(value as unknown as Record<string, unknown>);
    if (
      entries.length !== value.length + 1 ||
      entries.some(([key], index) => index < value.length && key !== String(index))
    )
      throw new Error("Content configuration is invalid");
    cloned = entries.slice(0, -1).map(([, entry]) => cloneSchema(entry, active));
  } else {
    cloned = Object.fromEntries(
      ownEntries(value).map(([key, entry]) => [key, cloneSchema(entry, active)]),
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
  } catch {
    throw new Error("Content configuration is invalid");
  }
  if (!plainObject(extension)) throw new Error("Content configuration is invalid");
  const fields = Object.fromEntries(ownEntries(extension));
  if (Object.keys(fields).some((key) => key !== "components" && key !== "variables"))
    throw new Error("Content configuration is invalid");
  const additional = fields.components ?? {};
  const variables = fields.variables ?? {};
  if (!plainObject(additional) || !plainObject(variables))
    throw new Error("Content configuration is invalid");
  const registry: Registry = { ...components };
  for (const [name, schema] of ownEntries(additional)) {
    // A previously resolved config may be passed back in. Always reapply the
    // canonical definitions instead of trusting caller modifications to them.
    if (Object.hasOwn(components, name)) continue;
    if (!validName(name) || name === "if" || name === "else" || !plainObject(schema))
      throw new Error("Content configuration is invalid");
    const definition = cloneSchema(schema);
    if (!validDefinition(definition)) throw new Error("Content configuration is invalid");
    registry[name] = definition;
  }
  return { components: registry, variables: cloneSchema(variables) as Record<string, unknown> };
}
