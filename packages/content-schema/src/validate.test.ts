import Markdoc, {
  type Config,
  type CustomAttributeType,
  type Node,
  type Schema,
  type ValidationError,
  type ValidationType,
} from "@markdoc/markdoc";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vite-plus/test";
import { topikComponents } from "./components";
import { mergeTopikMarkdocConfig, topikMarkdocConfig } from "./config";
import {
  ambiguousDiagnosticFiles,
  roundFourAmbiguousDiagnosticFiles,
  unsafeDiagnosticFiles,
} from "./test-fixtures/diagnostic-files";
import { validateTopikContent } from "./validate";

function idsFor(source: string): string[] {
  return validateTopikContent(source).errors.map((error) => error.id);
}

function findTag(root: Node | undefined, tag: string): Node | undefined {
  return root === undefined ? undefined : [root, ...root.walk()].find((node) => node.tag === tag);
}

const inheritedRegistryNames = Object.getOwnPropertyNames(Object.prototype);

const rejectedAttributeTypeValues: Array<[string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["false", false],
  ["true", true],
  ["zero", 0],
  ["number", 1],
  ["NaN", Number.NaN],
  ["bigint", 1n],
  ["symbol", Symbol("type")],
  ["plain object", {}],
  ["null-prototype object", Object.create(null)],
  ["boxed string", new String("String")],
  ["boxed number", new Number(1)],
  ["boxed boolean", new Boolean(true)],
  ["date", new Date(0)],
  ["regular expression", /String/u],
  ["empty string", ""],
  ["lowercase name", "string"],
  ["uppercase name", "STRING"],
  ["leading whitespace", " String"],
  ["trailing whitespace", "Array "],
  ["arbitrary name", "CustomType"],
  ...inheritedRegistryNames.map((name) => [`Object.prototype.${name}`, name] as [string, string]),
];

function victimSchema(): Schema {
  return {
    render: "span",
    selfClosing: true,
    attributes: {
      bad: { type: Boolean, required: true, matches: [false] as unknown as string[] },
    },
  };
}

function mutateLaterVictim(config: Config): void {
  const victim = findTag(config.validation?.parents?.[0], "victim");
  if (victim !== undefined) victim.attributes.bad = false;
}

type ValidationAttack = {
  callback: unknown;
  config: Config;
  source: string;
};

const validationAttackFactories: Array<[string, () => ValidationAttack]> = [
  [
    "tag schema validate",
    () => {
      const callback = vi.fn((_node: Node, config: Config) => {
        mutateLaterVictim(config);
        return [];
      });
      return {
        callback,
        source: "{% attack /%}\n{% victim bad=true /%}",
        config: {
          tags: {
            attack: { render: "span", selfClosing: true, validate: callback },
            victim: victimSchema(),
          },
        },
      };
    },
  ],
  [
    "node schema validate",
    () => {
      const callback = vi.fn((_node: Node, config: Config) => {
        mutateLaterVictim(config);
        return [];
      });
      return {
        callback,
        source: "Attack paragraph\n\n{% victim bad=true /%}",
        config: {
          nodes: { paragraph: { render: "p", validate: callback } },
          tags: { victim: victimSchema() },
        },
      };
    },
  ],
  [
    "attribute validate",
    () => {
      const callback = vi.fn((_value: unknown, config: Config) => {
        mutateLaterVictim(config);
        return [];
      });
      return {
        callback,
        source: "{% attack run=true /%}\n{% victim bad=true /%}",
        config: {
          tags: {
            attack: {
              render: "span",
              selfClosing: true,
              attributes: { run: { type: Boolean, validate: callback } },
            },
            victim: victimSchema(),
          },
        },
      };
    },
  ],
  [
    "functional matches",
    () => {
      const callback = vi.fn((config: Config) => {
        mutateLaterVictim(config);
        return [true] as unknown as string[];
      });
      return {
        callback,
        source: "{% attack run=true /%}\n{% victim bad=true /%}",
        config: {
          tags: {
            attack: {
              render: "span",
              selfClosing: true,
              attributes: { run: { type: Boolean, matches: callback } },
            },
            victim: victimSchema(),
          },
        },
      };
    },
  ],
  [
    "function validate",
    () => {
      const callback = vi.fn((_fn: unknown, config: Config) => {
        mutateLaterVictim(config);
        return [];
      });
      return {
        callback,
        source: '{% callout title=attack(value="safe") /%}\n{% victim bad=true /%}',
        config: {
          functions: {
            attack: {
              returns: String,
              parameters: { value: { type: String, required: true } },
              validate: callback,
              transform: () => "safe",
            },
          },
          tags: { victim: victimSchema() },
        },
      };
    },
  ],
];

type UnsupportedAttributeTypeCase = {
  observed: Array<ReturnType<typeof vi.fn>>;
  type: CustomAttributeType;
};

const unsupportedAttributeTypeCases: Array<[string, () => UnsupportedAttributeTypeCase]> = [
  [
    "prototype method",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      class UnsupportedType {
        constructor() {
          constructed();
        }

        validate() {
          return validate();
        }
      }
      return { observed: [constructed, validate], type: UnsupportedType };
    },
  ],
  [
    "own arrow field",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      class UnsupportedType {
        constructor() {
          constructed();
        }

        validate = validate;
      }
      return { observed: [constructed, validate], type: UnsupportedType };
    },
  ],
  [
    "inherited arrow field",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      class BaseType {
        validate = validate;
      }
      class UnsupportedType extends BaseType {
        constructor() {
          constructed();
          super();
        }
      }
      return { observed: [constructed, validate], type: UnsupportedType };
    },
  ],
  [
    "constructor-returned object",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      function UnsupportedType() {
        constructed();
        return { validate };
      }
      return {
        observed: [constructed, validate],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "constructor-returned singleton",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      const singleton = { validate };
      function UnsupportedType() {
        constructed();
        return singleton;
      }
      return {
        observed: [constructed, validate],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "arrow alias",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(() => []);
      const alias = (..._args: unknown[]) => validate();
      function UnsupportedType() {
        constructed();
        return { validate: alias };
      }
      return {
        observed: [constructed, validate],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "bound alias",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(function () {
        return [];
      });
      const alias = validate.bind({ state: "caller" });
      function UnsupportedType() {
        constructed();
        return { validate: alias };
      }
      return {
        observed: [constructed, validate],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "ordinary function alias",
    () => {
      const constructed = vi.fn();
      const validate = vi.fn(function () {
        return [];
      });
      function UnsupportedType() {
        constructed();
        return { validate };
      }
      return {
        observed: [constructed, validate],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "transform-only field",
    () => {
      const constructed = vi.fn();
      const transform = vi.fn((value: unknown) => value);
      class UnsupportedType {
        constructor() {
          constructed();
        }

        transform = transform;
      }
      return {
        observed: [constructed, transform],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "prototype accessor",
    () => {
      const constructed = vi.fn();
      const accessor = vi.fn(() => () => []);
      class UnsupportedType {
        constructor() {
          constructed();
        }

        get validate() {
          return accessor();
        }
      }
      return { observed: [constructed, accessor], type: UnsupportedType };
    },
  ],
  [
    "native-looking function",
    () => {
      const constructed = vi.fn();
      const sourceRead = vi.fn(() => "function String() { [native code] }");
      function UnsupportedType() {
        constructed();
      }
      Object.defineProperty(UnsupportedType, "toString", { value: sourceRead });
      return {
        observed: [constructed, sourceRead],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
  [
    "nominal class",
    () => {
      const constructed = vi.fn();
      class UnsupportedType {
        constructor() {
          constructed();
        }
      }
      return { observed: [constructed], type: UnsupportedType };
    },
  ],
  [
    "callable proxy",
    () => {
      const observed = vi.fn();
      const UnsupportedType = new Proxy(function UnsupportedType() {}, {
        apply() {
          observed();
          return {};
        },
        construct() {
          observed();
          return {};
        },
        get() {
          observed();
          return undefined;
        },
        getOwnPropertyDescriptor() {
          observed();
          return undefined;
        },
        getPrototypeOf() {
          observed();
          return null;
        },
      });
      return {
        observed: [observed],
        type: UnsupportedType as unknown as CustomAttributeType,
      };
    },
  ],
];

describe("topik content schema", () => {
  test.each(
    inheritedRegistryNames.flatMap((name) => [
      [name, `{% ${name} /%}`],
      [name, `{% ${name} private="PRIVATE_VALUE_SENTINEL" /%}`],
      [name, `Before {% ${name} /%} after`],
      [name, `{% ${name} %}{% ${name} /%}{% /${name} %}`],
    ]),
  )("requires an own registration for inherited tag name %s", (_name, source) => {
    const result = validateTopikContent(source);

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test.each(
    inheritedRegistryNames.flatMap((name) => [
      [name, `{% callout title=${name}() /%}`],
      [name, `{% callout title=${name}(private="PRIVATE_VALUE_SENTINEL") /%}`],
    ]),
  )("requires an own registration for inherited function name %s", (_name, source) => {
    const result = validateTopikContent(source);

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "function-undefined", level: "critical" }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test.each(inheritedRegistryNames)(
    "requires own registrations for inherited name %s inside a partial closure",
    (name) => {
      const source = '{% partial file="part.md" /%}';
      const result = validateTopikContent(source, {
        config: {
          partials: {
            "part.md": Markdoc.parse(
              `{% ${name} private="PRIVATE_VALUE_SENTINEL" /%}\n{% callout title=${name}() /%}`,
            ),
          },
        },
      });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "tag-undefined", level: "critical" }),
          expect.objectContaining({ id: "function-undefined", level: "critical" }),
        ]),
      );
      expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    },
  );

  test.each(inheritedRegistryNames)(
    "preserves an explicitly own-registered inherited tag and function name %s",
    (name) => {
      const tags = Object.create(null) as NonNullable<Config["tags"]>;
      const functions = Object.create(null) as NonNullable<Config["functions"]>;
      tags[name] = { render: "span", selfClosing: true };
      functions[name] = { returns: String, transform: () => "Safe title" };
      const inherited = Object.prototype[name as keyof typeof Object.prototype] as unknown;
      const hadAttributes =
        (typeof inherited === "object" && inherited !== null) || typeof inherited === "function"
          ? Object.hasOwn(inherited, "attributes")
          : false;
      const attributes = hadAttributes
        ? (inherited as { attributes?: unknown }).attributes
        : undefined;

      try {
        const tagSource = `{% ${name} /%}`;
        const functionSource = `{% callout title=${name}() /%}`;
        expect(validateTopikContent(tagSource, { config: { tags } })).toMatchObject({
          source: tagSource,
          valid: true,
          errors: [],
        });
        expect(validateTopikContent(functionSource, { config: { functions } })).toMatchObject({
          source: functionSource,
          valid: true,
          errors: [],
        });
        if (
          ((typeof inherited === "object" && inherited !== null) ||
            typeof inherited === "function") &&
          !hadAttributes
        ) {
          expect(Object.hasOwn(inherited, "attributes")).toBe(false);
        }
      } finally {
        if (
          (typeof inherited === "object" && inherited !== null) ||
          typeof inherited === "function"
        ) {
          if (hadAttributes) Reflect.set(inherited, "attributes", attributes);
          else Reflect.deleteProperty(inherited, "attributes");
        }
      }
    },
  );

  test("isolates plain, class, shared, array, cyclic, Map, Set, and Date variable graphs", () => {
    class Selection {
      which = "safe.md";
    }
    const shared = { value: "safe" };
    const cyclic: Record<string, unknown> = { value: "safe" };
    cyclic.self = cyclic;
    const variables = {
      selection: new Selection(),
      shared,
      array: [shared],
      cyclic,
      map: new Map([["value", shared]]),
      set: new Set([shared]),
      date: new Date(0),
    };
    const validator = vi.fn((_node: Node, config: Config) => {
      const effective = config.variables as typeof variables;
      effective.selection.which = "bad.md";
      effective.shared.value = "changed";
      effective.array[0].value = "changed";
      effective.cyclic.value = "changed";
      effective.map.get("value")!.value = "changed";
      [...effective.set][0].value = "changed";
      effective.date.setTime(1);
      return [];
    });
    const source = "{% attack /%}\n{% partial file=$selection.which /%}";
    const result = validateTopikContent(source, {
      config: {
        variables,
        partials: {
          "safe.md": Markdoc.parse("Safe child"),
          "bad.md": Markdoc.parse("{% quiz %}ordinary child{% /quiz %}"),
        },
        tags: { attack: { render: "span", validate: validator } },
      },
    });

    expect(result).toMatchObject({ source, valid: true, errors: [] });
    expect(validator).toHaveBeenCalledOnce();
    expect(variables.selection.which).toBe("safe.md");
    expect(shared.value).toBe("safe");
    expect(cyclic.value).toBe("safe");
    expect(variables.date.getTime()).toBe(0);
  });

  test.each([
    ["WeakMap", new WeakMap()],
    ["WeakSet", new WeakSet()],
    ["Promise", Promise.resolve("PRIVATE_VALUE_SENTINEL")],
    ["ArrayBuffer", new ArrayBuffer(8)],
    ["SharedArrayBuffer", new SharedArrayBuffer(8)],
    ["DataView", new DataView(new ArrayBuffer(8))],
    ["typed array", new Uint8Array(8)],
    ["WeakRef", new WeakRef({})],
    ["Error", new Error("PRIVATE_VALUE_SENTINEL")],
  ])("fails an unsupported %s variable graph closed", (_name, malformed) => {
    const source = "{% callout title=$malformed /%}";
    const result = validateTopikContent(source, { config: { variables: { malformed } } });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-config-invalid" })]),
    );
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("converts extension callback exceptions to a sanitized blocking diagnostic", () => {
    const source = "{% attack /%}";
    const result = validateTopikContent(source, {
      config: {
        tags: {
          attack: {
            render: "span",
            validate: () => {
              throw new Error("PRIVATE_VALUE_SENTINEL");
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      source,
      valid: false,
      errors: [
        expect.objectContaining({
          id: "topik-extension-failed",
          message: "Content extension validation failed.",
        }),
      ],
    });
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("retains the static victim-only rejection control", () => {
    const source = "{% victim bad=true /%}";
    const result = validateTopikContent(source, {
      config: { tags: { victim: victimSchema() } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "attribute-value-invalid", level: "error" }),
      ]),
    );
  });

  test.each(validationAttackFactories)(
    "isolates each sibling %s invocation from later validation state",
    (_name, createAttack) => {
      const { callback, config, source } = createAttack();
      const result = validateTopikContent(source, { config });

      expect(callback).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "attribute-value-invalid", level: "error" }),
        ]),
      );
      expect(findTag(Markdoc.parse(source), "victim")?.attributes.bad).toBe(true);
      const victim = config.tags?.victim?.attributes?.bad as { matches?: unknown[] } | undefined;
      expect(victim?.matches).toEqual([false]);
    },
  );

  test.each(validationAttackFactories)(
    "isolates each reachable-partial %s invocation from later validation state",
    (_name, createAttack) => {
      const { callback, config, source: partialSource } = createAttack();
      const source = '{% partial file="attack.md" /%}';
      const partial = Markdoc.parse(partialSource, {
        file: "/tmp/SENSITIVE_DIRECTORY/attack.md",
      });
      const result = validateTopikContent(source, {
        config: {
          ...config,
          partials: { ...config.partials, "attack.md": partial },
        },
      });

      expect(callback).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "attribute-value-invalid",
            level: "error",
            file: "attack.md",
          }),
        ]),
      );
      expect(findTag(partial, "victim")?.attributes.bad).toBe(true);
      const victim = config.tags?.victim?.attributes?.bad as { matches?: unknown[] } | undefined;
      expect(victim?.matches).toEqual([false]);
      expect(JSON.stringify(result.errors)).not.toContain("SENSITIVE_DIRECTORY");
    },
  );

  test("isolates a callback's configuration graph from later custom schema validation", () => {
    const source = "{% attack /%}\n{% victim bad=true /%}";
    const callback = vi.fn((_node: Node, config: Config) => {
      const bad = config.tags?.victim?.attributes?.bad;
      if (bad !== undefined) bad.matches = [true] as unknown as string[];
      return [];
    });
    const config: Config = {
      tags: {
        attack: { render: "span", selfClosing: true, validate: callback },
        victim: victimSchema(),
      },
    };
    const result = validateTopikContent(source, { config });

    expect(callback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "attribute-value-invalid" })]),
    );
    expect(config.tags?.victim?.attributes?.bad?.matches).toEqual([false]);
  });

  test.each([
    [String, 'value="safe"'],
    [Number, "value=1"],
    [Boolean, "value=true"],
    [Object, 'value={safe: "value"}'],
    [Array, 'value=["safe"]'],
    ["String", 'value="safe"'],
    ["Number", "value=1"],
    ["Boolean", "value=true"],
    ["Object", 'value={safe: "value"}'],
    ["Array", 'value=["safe"]'],
  ] as const)("keeps native attribute type %s unchanged", (type, attribute) => {
    const source = `{% notice ${attribute} /%}`;
    const config: Config = {
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: { value: { type: type as unknown as ValidationType } },
        },
      },
    };
    const merged = mergeTopikMarkdocConfig(config);
    const mergedAgain = mergeTopikMarkdocConfig(merged);

    expect(merged.tags?.notice?.attributes?.value?.type).toBe(type);
    expect(mergedAgain.tags?.notice?.attributes?.value?.type).toBe(type);
    expect(validateTopikContent(source, { config })).toMatchObject({
      source,
      valid: true,
      errors: [],
    });
  });

  test.each(rejectedAttributeTypeValues)(
    "rejects unsupported runtime attribute type %s as configuration",
    (_name, type) => {
      const source = '{% notice value="safe" /%}';
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: type as ValidationType } },
          },
        },
      };

      expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
        "Unsupported attribute type configuration",
      );
      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [
          expect.objectContaining({
            id: "topik-config-invalid",
            level: "critical",
            message: "Content configuration is invalid.",
          }),
        ],
      });
    },
  );

  test.each(["constructor", null, ["String", "constructor"]] as const)(
    "rejects reviewed unsupported attribute type %# before Markdoc validation",
    (type) => {
      const source = "{% notice value={x: 1} /%}\n![Asset](old.png)";
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: type as unknown as ValidationType } },
          },
        },
      };

      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
    },
  );

  test("preserves omitted attribute and return types but rejects present undefined values", () => {
    const source = '{% notice value="safe" label=label(value="safe") /%}';
    const transform = vi.fn(() => "safe");
    const omitted: Config = {
      functions: {
        label: {
          parameters: { value: { required: true } },
          transform,
        },
      },
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: { label: {}, value: {} },
        },
      },
    };
    const merged = mergeTopikMarkdocConfig(omitted);

    expect(Object.hasOwn(merged.tags?.notice?.attributes?.value ?? {}, "type")).toBe(false);
    expect(Object.hasOwn(merged.functions?.label ?? {}, "returns")).toBe(false);
    expect(Object.hasOwn(merged.functions?.label?.parameters?.value ?? {}, "type")).toBe(false);
    expect(validateTopikContent(source, { config: omitted })).toMatchObject({
      source,
      valid: true,
      errors: [],
    });

    for (const config of [
      {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: undefined } },
          },
        },
      },
      {
        functions: { label: { returns: undefined, transform } },
      },
      {
        functions: {
          label: { parameters: { value: { type: undefined } }, transform },
        },
      },
    ] satisfies Config[]) {
      expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
        "Unsupported attribute type configuration",
      );
      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid" })],
      });
    }
    expect(transform).not.toHaveBeenCalled();
  });

  test.each(["attribute", "parameter", "return"] as const)(
    "rejects inherited and accessor-backed %s type fields without invoking accessors",
    (position) => {
      for (const field of ["inherited", "accessor"] as const) {
        const getter = vi.fn(() => String);
        const typed =
          field === "inherited"
            ? Object.create({ type: String })
            : Object.defineProperty({}, "type", { get: getter });
        const returned =
          field === "inherited"
            ? Object.create({ returns: String })
            : Object.defineProperty({}, "returns", { get: getter });
        Object.defineProperty(returned, "transform", {
          configurable: true,
          enumerable: true,
          value: () => "safe",
          writable: true,
        });
        const config = (
          position === "return"
            ? { functions: { label: returned } }
            : position === "parameter"
              ? {
                  functions: {
                    label: {
                      returns: String,
                      parameters: { value: typed },
                      transform: () => "safe",
                    },
                  },
                }
              : {
                  tags: {
                    notice: {
                      render: "span",
                      selfClosing: true,
                      attributes: { value: typed },
                    },
                  },
                }
        ) as Config;

        expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
          "Unsupported attribute type configuration",
        );
        expect(getter).not.toHaveBeenCalled();
      }
    },
  );

  test("admits fresh dense snapshots of recursively supported type arrays", () => {
    const shared = [String, "Number"] as ValidationType[];
    const type = [shared, [Boolean, ["Object", Array]], shared] as unknown as ValidationType;
    const config: Config = {
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: { value: { type } },
        },
      },
    };
    const merged = mergeTopikMarkdocConfig(config);
    const mergedAgain = mergeTopikMarkdocConfig(merged);
    const admitted = merged.tags?.notice?.attributes?.value?.type as unknown[];
    const admittedAgain = mergedAgain.tags?.notice?.attributes?.value?.type as unknown[];

    expect(admitted).toEqual(type);
    expect(admitted).not.toBe(type);
    expect(admitted[0]).not.toBe(shared);
    expect(admitted[0]).not.toBe(admitted[2]);
    expect(admittedAgain).toEqual(type);
    expect(admittedAgain).not.toBe(admitted);
    shared[0] = Number;
    expect(admitted[0]).toEqual([String, "Number"]);

    const emptyConfig: Config = {
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: { value: { type: [] } },
        },
      },
    };
    expect(() => mergeTopikMarkdocConfig(emptyConfig)).not.toThrow();
  });

  test.each(["attribute", "parameter", "return"] as const)(
    "preserves recursively supported arrays in %s type positions",
    (position) => {
      const type = [String, ["Number", [Boolean, "Object", Array]]] as unknown as ValidationType;
      const transform = vi.fn(() => "safe");
      const source =
        position === "attribute"
          ? '{% notice value="safe" /%}'
          : position === "parameter"
            ? '{% callout title=custom(value="safe") /%}'
            : "{% callout title=custom() /%}";
      const config: Config =
        position === "attribute"
          ? {
              tags: {
                notice: {
                  render: "span",
                  selfClosing: true,
                  attributes: { value: { type } },
                },
              },
            }
          : {
              functions: {
                custom:
                  position === "parameter"
                    ? { returns: String, parameters: { value: { type } }, transform }
                    : { returns: type, transform },
              },
            };

      expect(() => mergeTopikMarkdocConfig(config)).not.toThrow();
      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: true,
        errors: [],
      });
      expect(transform).not.toHaveBeenCalled();
    },
  );

  test("rejects sparse, accessor-backed, cyclic, and nested unsupported type arrays", () => {
    const getter = vi.fn(() => String);
    const sparse: ValidationType[] = [String, Number];
    Reflect.deleteProperty(sparse, "0");
    const nestedHole: ValidationType[] = [String];
    Reflect.deleteProperty(nestedHole, "0");
    const nestedSparse = [String, nestedHole] as unknown as ValidationType;
    const accessor: unknown[] = [String];
    Object.defineProperty(accessor, "0", { get: getter });
    const selfCycle: unknown[] = [String];
    selfCycle.push(selfCycle);
    const left: unknown[] = [String];
    const right: unknown[] = [Number, left];
    left.push(right);

    for (const type of [
      sparse,
      nestedSparse,
      accessor,
      selfCycle,
      left,
      [String, ["constructor"]],
    ]) {
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: type as ValidationType } },
          },
        },
      };
      expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
        "Unsupported attribute type configuration",
      );
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test("rejects an array proxy that reports an invalid length with a fixed error", () => {
    const descriptorTrap = vi.fn((_target: unknown[], key: PropertyKey) =>
      key === "length"
        ? { configurable: false, enumerable: false, value: -1, writable: true }
        : undefined,
    );
    const type = new Proxy([], { getOwnPropertyDescriptor: descriptorTrap });
    const config: Config = {
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: { value: { type: type as unknown as ValidationType } },
        },
      },
    };

    expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
      "Unsupported attribute type configuration",
    );
    expect(descriptorTrap).toHaveBeenCalledOnce();
    expect(descriptorTrap).toHaveBeenCalledWith(expect.any(Array), "length");
  });

  test("rejects non-native constructors and non-array proxies without observing them", () => {
    const constructed = vi.fn();
    const trapped = vi.fn();
    const CrossRealmString = runInNewContext("String") as typeof String;
    class CustomType {
      constructor() {
        constructed();
      }
    }
    const proxiedNative = new Proxy(String, {
      apply() {
        trapped();
        return "";
      },
      construct() {
        trapped();
        return {};
      },
      get() {
        trapped();
        return undefined;
      },
      getOwnPropertyDescriptor() {
        trapped();
        return undefined;
      },
      getPrototypeOf() {
        trapped();
        return null;
      },
    });
    const proxiedObject = new Proxy(
      {},
      {
        get() {
          trapped();
          return undefined;
        },
        getOwnPropertyDescriptor() {
          trapped();
          return undefined;
        },
        getPrototypeOf() {
          trapped();
          return null;
        },
        ownKeys() {
          trapped();
          return [];
        },
      },
    );

    for (const type of [CustomType, CrossRealmString, proxiedNative, proxiedObject]) {
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: type as ValidationType } },
          },
        },
      };
      expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
        "Unsupported attribute type configuration",
      );
    }
    expect(constructed).not.toHaveBeenCalled();
    expect(trapped).not.toHaveBeenCalled();
  });

  test.each(["parameter", "return"] as const)(
    "applies closed runtime admission to function %s types",
    (position) => {
      const transform = vi.fn(() => "safe");
      const schema =
        position === "parameter"
          ? {
              returns: String,
              parameters: { value: { type: "constructor" as ValidationType } },
              transform,
            }
          : { returns: [String, null] as unknown as ValidationType[], transform };
      const source =
        position === "parameter"
          ? '{% callout title=custom(value="safe") /%}'
          : "{% callout title=custom() /%}";
      const config: Config = { functions: { custom: schema } };

      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
      expect(transform).not.toHaveBeenCalled();
    },
  );

  test.each(unsupportedAttributeTypeCases)(
    "rejects unsupported function attribute type %s before observing executable state",
    (_name, createCase) => {
      const { observed, type } = createCase();
      const source = '{% notice value="safe" /%}';
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type } },
          },
        },
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
          "Unsupported attribute type configuration",
        );
      }
      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [
          expect.objectContaining({
            id: "topik-config-invalid",
            level: "critical",
            message: "Content configuration is invalid.",
          }),
        ],
      });
      for (const observer of observed) expect(observer).not.toHaveBeenCalled();
    },
  );

  test("rejects paired singleton validation state before either field is observed", () => {
    const constructed = vi.fn();
    const validate = vi.fn(function (this: { primed: boolean }, value: unknown) {
      if (value === "prime") {
        this.primed = true;
        return [];
      }
      return this.primed ? [] : [{ id: "field-rejected", level: "error", message: "Rejected" }];
    });
    const singleton = {
      primed: false,
      validate: (value: unknown) => validate.call(singleton, value),
    };
    function StatefulType() {
      constructed();
      return singleton;
    }
    const type = StatefulType as unknown as CustomAttributeType;
    const config: Config = {
      tags: {
        notice: {
          render: "span",
          selfClosing: true,
          attributes: {
            first: { type },
            second: { type },
          },
        },
      },
    };
    const control = '{% notice second="reject" /%}';
    const combined = '{% notice first="prime" second="reject" /%}';

    for (const source of [control, combined]) {
      expect(validateTopikContent(source, { config })).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
    }
    expect(constructed).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(singleton.primed).toBe(false);
  });

  test.each(["parameter", "return"] as const)(
    "rejects unsupported function %s types before validation or transformation",
    (position) => {
      const constructed = vi.fn();
      const callback = vi.fn(() => []);
      const transform = vi.fn(() => "safe");
      class UnsupportedType {
        constructor() {
          constructed();
        }

        validate = callback;
      }
      const functionSchema =
        position === "parameter"
          ? {
              returns: String,
              parameters: { value: { type: UnsupportedType, required: true } },
              transform,
            }
          : {
              returns: UnsupportedType,
              transform,
            };
      const source =
        position === "parameter"
          ? '{% callout title=custom(value="safe") /%}'
          : "{% callout title=custom() /%}";
      const result = validateTopikContent(source, {
        config: { functions: { custom: functionSchema } },
      });

      expect(result).toMatchObject({
        source,
        valid: false,
        errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
      });
      expect(constructed).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();
    },
  );

  test("rejects unsupported nested and cyclic type arrays deterministically", () => {
    const constructed = vi.fn();
    class UnsupportedType {
      constructor() {
        constructed();
      }
    }
    const nested = [String, [Number, UnsupportedType]] as unknown as ValidationType;
    const cyclic: unknown[] = [String];
    cyclic.push(cyclic);

    for (const type of [nested, cyclic as unknown as ValidationType]) {
      const config: Config = {
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type } },
          },
        },
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(() => mergeTopikMarkdocConfig(config)).toThrowError(
          "Unsupported attribute type configuration",
        );
        expect(validateTopikContent('{% notice value="safe" /%}', { config })).toMatchObject({
          valid: false,
          errors: [expect.objectContaining({ id: "topik-config-invalid" })],
        });
      }
    }
    expect(constructed).not.toHaveBeenCalled();
  });

  test("rejects unsupported types in reachable partials before construction or callbacks", () => {
    const constructed = vi.fn();
    const validate = vi.fn(() => []);
    class UnsupportedType {
      constructor() {
        constructed();
      }

      validate = validate;
    }
    const source = '{% partial file="part.md" /%}';
    const result = validateTopikContent(source, {
      config: {
        partials: { "part.md": Markdoc.parse('{% notice value="safe" /%}') },
        tags: {
          notice: {
            render: "span",
            selfClosing: true,
            attributes: { value: { type: UnsupportedType } },
          },
        },
      },
    });

    expect(result).toMatchObject({
      source,
      valid: false,
      errors: [expect.objectContaining({ id: "topik-config-invalid", level: "critical" })],
    });
    expect(constructed).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  test.each([/^safe$/gu, /^safe$/uy])(
    "evaluates stateful static matches independently for every attribute",
    (matches) => {
      const source = ['{% notice value="safe" /%}', '{% notice value="safe" /%}'].join("\n");
      const result = validateTopikContent(source, {
        config: {
          tags: {
            notice: {
              render: "span",
              selfClosing: true,
              attributes: { value: { type: String, matches } },
            },
          },
        },
      });

      expect(result).toMatchObject({ source, valid: true, errors: [] });
      expect(matches.lastIndex).toBe(0);
    },
  );

  test("preserves receiver, node, ancestry, and config identity inside one private snapshot", () => {
    const source = "{% notice /%}";
    const callback = vi.fn(function (this: unknown, node: Node, config: Config) {
      const root = config.validation?.parents?.[0];
      expect(this).toBe(config.tags?.notice);
      expect(findTag(root, "notice")).toBe(node);
      expect(root?.type).toBe("document");
      return [];
    });
    const schema = { render: "span", selfClosing: true, validate: callback };

    expect(validateTopikContent(source, { config: { tags: { notice: schema } } })).toMatchObject({
      source,
      valid: true,
      errors: [],
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(schema).toEqual({ render: "span", selfClosing: true, validate: callback });
  });

  test("preserves readable ancestry and invokes a valid partial extension exactly once", () => {
    const source = '{% partial file="notice.md" /%}';
    const partial = Markdoc.parse("{% notice /%}");
    const callback = vi.fn(function (this: unknown, node: Node, config: Config) {
      const root = config.validation?.parents?.[0];
      expect(this).toBe(config.tags?.notice);
      expect(findTag(root, "notice")).toBe(node);
      expect(root?.type).toBe("document");
      return [];
    });
    const result = validateTopikContent(source, {
      config: {
        partials: { "notice.md": partial },
        tags: { notice: { render: "span", selfClosing: true, validate: callback } },
      },
    });

    expect(result).toMatchObject({ source, valid: true, errors: [] });
    expect(callback).toHaveBeenCalledOnce();
    expect(findTag(partial, "notice")).toBeDefined();
  });

  test("isolates extension validation return values before Markdoc annotates them", () => {
    const source = "{% notice /%}";
    const returnedError: ValidationError = {
      id: "extension-warning",
      level: "warning",
      message: "Safe extension warning.",
    };
    const callback = vi.fn(() => [returnedError]);
    const result = validateTopikContent(source, {
      config: { tags: { notice: { render: "span", selfClosing: true, validate: callback } } },
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ source, valid: true });
    expect(result.errors).toEqual([
      expect.objectContaining({ id: "extension-warning", level: "warning" }),
    ]);
    expect(returnedError).not.toHaveProperty("location");
  });

  test("fails an unsupported extension validation return graph closed", () => {
    const source = "{% notice /%}";
    const callback = vi.fn(
      () =>
        [
          {
            id: "extension-warning",
            level: "warning",
            message: "PRIVATE_VALUE_SENTINEL",
            unsupported: new WeakMap(),
          },
        ] as unknown as ValidationError[],
    );
    const result = validateTopikContent(source, {
      config: { tags: { notice: { render: "span", selfClosing: true, validate: callback } } },
    });

    expect(callback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      source,
      valid: false,
      errors: [expect.objectContaining({ id: "topik-extension-failed", level: "critical" })],
    });
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("fails unsupported asynchronous extension validation closed without leaking rejection", async () => {
    const source = "{% attack /%}";
    const result = validateTopikContent(source, {
      config: {
        tags: {
          attack: {
            render: "span",
            selfClosing: true,
            validate: async () => {
              await Promise.resolve();
              throw new Error("PRIVATE_VALUE_SENTINEL");
            },
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({
      source,
      valid: false,
      errors: [
        expect.objectContaining({
          id: "topik-extension-failed",
          message: "Content extension validation failed.",
        }),
      ],
    });
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
  });

  test("public config maps and nested schemas cannot mutate canonical validation authority", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const publicConfig = topikMarkdocConfig as unknown as Record<string, unknown>;
    const publicTags = topikMarkdocConfig.tags as unknown as Record<string, unknown>;
    const publicQuiz = topikMarkdocConfig.tags.quiz as unknown as Record<string, unknown>;
    const originalTags = publicConfig.tags;
    const originalQuiz = publicTags.quiz;
    const originalValidate = publicQuiz.validate;

    try {
      const mutationResults = [
        Reflect.set(publicQuiz, "validate", () => []),
        Reflect.set(publicTags, "quiz", { render: "TopikQuiz", validate: () => [] }),
        Reflect.set(publicConfig, "tags", {
          quiz: { render: "TopikQuiz", validate: () => [] },
        }),
      ];

      expect(mutationResults).toEqual([false, false, false]);
      const result = validateTopikContent(source);
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
      );
    } finally {
      Reflect.set(publicConfig, "tags", originalTags);
      Reflect.set(publicTags, "quiz", originalQuiz);
      Reflect.set(publicQuiz, "validate", originalValidate);
    }
  });

  test("merged config snapshots cannot mutate or replace canonical validation authority", () => {
    const source = "{% quiz %}ordinary child{% /quiz %}";
    const first = mergeTopikMarkdocConfig();
    const second = mergeTopikMarkdocConfig();
    const firstQuiz = first.tags?.quiz as Record<string, unknown>;

    expect(first.tags).not.toBe(topikMarkdocConfig.tags);
    expect(first.tags).not.toBe(second.tags);
    expect(firstQuiz).not.toBe(topikMarkdocConfig.tags.quiz);
    expect(firstQuiz).not.toBe(second.tags?.quiz);

    const originalValidate = firstQuiz.validate;
    try {
      expect(Reflect.set(firstQuiz, "validate", () => [])).toBe(true);
      expect(
        Reflect.set(first, "tags", { quiz: { render: "TopikQuiz", validate: () => [] } }),
      ).toBe(true);

      const result = validateTopikContent(source, { config: first });
      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
      );
    } finally {
      Reflect.set(firstQuiz, "validate", originalValidate);
    }
  });

  test("canonical validation cannot be replaced through normal configuration", () => {
    const source = "{% quiz %}{% /quiz %}";
    const result = validateTopikContent(source, {
      config: { tags: { quiz: { render: "TopikQuiz" } } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
    );
  });

  test("rejects canonical errors before extension callbacks can mutate validation state", () => {
    const invalidQuiz = "{% attack /%}\n{% quiz %}ordinary child{% /quiz %}";
    const validQuiz = findTag(
      Markdoc.parse(`{% quiz %}
{% question type="single-choice" %}
{% choice correct=true %}Yes{% /choice %}
{% choice %}No{% /choice %}
{% /question %}
{% /quiz %}`),
      "quiz",
    );
    const cases: Array<{
      mutate: (node: Node, config: Config) => void;
      source: string;
    }> = [
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = config.tags?.quiz as Record<string, unknown>;
          Reflect.set(quiz, "validate", () => []);
        },
      },
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = findTag(config.validation?.parents?.[0], "quiz");
          if (quiz !== undefined) quiz.tag = "attack";
        },
      },
      {
        source: '{% attack /%}\n{% callout variant="PRIVATE_VALUE_SENTINEL" /%}',
        mutate: (_node, config) => {
          const callout = findTag(config.validation?.parents?.[0], "callout");
          if (callout !== undefined) callout.attributes.variant = "info";
        },
      },
      {
        source: invalidQuiz,
        mutate: (_node, config) => {
          const quiz = findTag(config.validation?.parents?.[0], "quiz");
          if (quiz !== undefined && validQuiz !== undefined) quiz.children = validQuiz.children;
        },
      },
      {
        source: "{% attack %}{% quiz %}ordinary child{% /quiz %}{% /attack %}",
        mutate: (node) => {
          const quiz = findTag(node, "quiz");
          if (quiz !== undefined) quiz.tag = "attack";
          node.attributes.changed = true;
          node.children = [];
        },
      },
    ];

    for (const { mutate, source } of cases) {
      const extensionValidator = vi.fn((node: Node, config: Config) => {
        mutate(node, config);
        return [];
      });
      const result = validateTopikContent(source, {
        config: { tags: { attack: { render: "div", validate: extensionValidator } } },
      });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
        ]),
      );
      expect(extensionValidator).not.toHaveBeenCalled();
    }
  });

  test("isolates caller and returned extension graphs from extension validation", () => {
    const source = '{% attack value="original" /%}';
    const attribute = { type: String };
    const extensionValidator = vi.fn((_node: Node, config: Config) => {
      const effectiveAttack = config.tags?.attack as Record<string, unknown>;
      const effectiveAttributes = effectiveAttack.attributes as Record<string, unknown>;
      Reflect.set(effectiveAttack, "render", "mutated");
      Reflect.set(effectiveAttributes, "value", { type: Number });
      return [];
    });
    const schema = {
      render: "div",
      attributes: { value: attribute },
      validate: extensionValidator,
    };
    const extension = { tags: { attack: schema } };
    const returned = mergeTopikMarkdocConfig(extension);

    expect(validateTopikContent(source, { config: returned })).toMatchObject({ valid: true });
    expect(extensionValidator).toHaveBeenCalledOnce();
    expect(schema.render).toBe("div");
    expect(schema.attributes.value).toBe(attribute);
    expect(returned.tags?.attack).toMatchObject({
      render: "div",
      attributes: { value: attribute },
    });
    expect(topikMarkdocConfig.tags.quiz).toHaveProperty("validate", expect.any(Function));
  });

  test("rejects canonical errors in the complete reachable partial closure before callbacks", () => {
    const source = '{% partial file="outer.md" /%}';
    const extensionValidator = vi.fn(() => []);
    const partials = {
      "outer.md": Markdoc.parse('{% partial file="inner.md" /%}'),
      "inner.md": Markdoc.parse("{% attack /%}\n{% quiz %}ordinary child{% /quiz %}", {
        file: "/tmp/SENSITIVE_DIRECTORY/inner.md",
      }),
    };

    const result = validateTopikContent(source, {
      config: {
        partials,
        tags: { attack: { render: "div", validate: extensionValidator } },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "topik-quiz-requires-question",
          file: "inner.md",
        }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(
      /ordinary child|SENSITIVE_DIRECTORY|\/tmp\//u,
    );
    expect(extensionValidator).not.toHaveBeenCalled();
  });

  test("validates partial arrays once when their AST is shared by multiple names", () => {
    const source = ['{% partial file="first.md" /%}', '{% partial file="second.md" /%}'].join("\n");
    const invalid = Markdoc.parse("{% quiz %}ordinary child{% /quiz %}");
    const shared = [Markdoc.parse("# Safe"), invalid];
    const result = validateTopikContent(source, {
      config: { partials: { "first.md": shared, "second.md": shared } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors.filter(({ id }) => id === "topik-quiz-requires-question")).toHaveLength(1);
  });

  test.each([
    {
      name: "a literal partial name",
      source: '{% partial file="asset.md" /%}',
      variables: {},
    },
    {
      name: "a variable-selected partial name",
      source: "{% partial file=$selection.which /%}",
      variables: { selection: { which: "asset.md" } },
    },
  ])(
    "applies canonical Asset policy throughout the partial closure for $name",
    ({ source, variables }) => {
      const partial = Markdoc.parse("![Asset](safe.png)", {
        file: "/tmp/SENSITIVE_DIRECTORY/asset.md",
      });
      const image = [partial, ...partial.walk()].find((node) => node.type === "image");
      if (image === undefined) throw new Error("Expected image fixture");
      image.attributes.src = "é.png";
      const result = validateTopikContent(source, {
        config: {
          variables,
          partials: {
            "asset.md": partial,
          },
        },
      });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "asset.md" }),
        ]),
      );
      expect(JSON.stringify(result.errors)).not.toMatch(/é\.png|SENSITIVE_DIRECTORY|\/tmp\//u);
    },
  );

  test.each([
    ["insecure HTTP", "http://example.com/file.pdf", false],
    ["credentialed HTTPS", "https://user:PRIVATE_VALUE_SENTINEL@example.com/file.pdf", false],
    ["malformed URL", "https://[PRIVATE_VALUE_SENTINEL", false],
    ["generated Asset authoring reference", `asset:auto-v1-${"a".repeat(52)}`, false],
    ["canonical local navigation", "guides/lesson.md", true],
    ["canonical HTTPS navigation", "https://example.com/file.pdf", true],
    ["ordinary fragment navigation", "#lesson", true],
  ])("applies direct link policy to a partial $name", (_name, href, valid) => {
    const source = '{% partial file="outer.md" /%}';
    const result = validateTopikContent(source, {
      config: {
        partials: {
          "outer.md": Markdoc.parse('{% partial file="part.md" /%}'),
          "part.md": [Markdoc.parse("Shared"), Markdoc.parse(`[Download](${href})`)],
        },
      },
    });

    expect(result).toMatchObject({ source, valid });
    if (!valid) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
        ]),
      );
      expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    }
  });

  test("applies partial link policy through variable and local-variable selection", () => {
    const source = '{% partial file="outer.md" variables={which: $target} /%}';
    const result = validateTopikContent(source, {
      config: {
        variables: { target: "part.md" },
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "part.md": Markdoc.parse("[Download](http://example.com/file.pdf)"),
        },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" })]),
    );
  });

  test.each([
    {
      partials: (() => {
        const partials: Record<string, Node> = {};
        partials["self.md"] = Markdoc.parse('{% partial file="self.md" /%}');
        return partials;
      })(),
      source: '{% partial file="self.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: {
        "a.md": Markdoc.parse('{% partial file="b.md" /%}'),
        "b.md": Markdoc.parse('{% partial file="a.md" /%}'),
      },
      source: '{% partial file="a.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: { "bad.md": { private: "PRIVATE_VALUE_SENTINEL" } },
      source: '{% partial file="bad.md" /%}',
      id: "topik-partial-invalid",
    },
    {
      partials: { "bad.md": [Markdoc.parse("# Safe"), "PRIVATE_VALUE_SENTINEL"] },
      source: '{% partial file="bad.md" /%}',
      id: "topik-partial-invalid",
    },
    {
      partials: (() => {
        const root = Markdoc.parse("# Cyclic AST");
        root.children.push(root);
        return { "cycle.md": root };
      })(),
      source: '{% partial file="cycle.md" /%}',
      id: "topik-partial-cycle",
    },
    {
      partials: (() => {
        const roots: unknown[] = [];
        roots.push(roots);
        return { "cycle.md": roots };
      })(),
      source: '{% partial file="cycle.md" /%}',
      id: "topik-partial-invalid",
    },
  ])("fails a cyclic or malformed partial graph closed", ({ id, partials, source }) => {
    const result = validateTopikContent(source, { config: { partials } });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|self\.md|a\.md|b\.md|bad\.md|cycle\.md/u,
    );
  });

  test("clones partial AST graphs without changing valid partial and custom-function behavior", () => {
    const source = '{% partial file="safe.md" /%}';
    const partial = Markdoc.parse("{% callout title=label() %}Custom child{% /callout %}");
    const transform = vi.fn(() => "Safe title");
    const extension = {
      functions: { label: { returns: String, transform } },
      partials: { "safe.md": partial },
    };
    const first = mergeTopikMarkdocConfig(extension);
    const second = mergeTopikMarkdocConfig(extension);

    expect(first.partials?.["safe.md"]).not.toBe(partial);
    expect(first.partials?.["safe.md"]).not.toBe(second.partials?.["safe.md"]);
    expect(validateTopikContent(source, { config: extension })).toMatchObject({
      source,
      valid: true,
      errors: [],
    });
    expect(transform).not.toHaveBeenCalled();
  });

  test("ignores malformed partial graphs that are not reachable from the source", () => {
    const source = "# Safe";
    const result = validateTopikContent(source, {
      config: {
        partials: {
          "unused.md": { private: "PRIVATE_VALUE_SENTINEL" },
        },
      },
    });

    expect(result).toEqual({ source, valid: true, errors: [] });
  });

  test.each([
    {
      name: "a top-level variable",
      source: "{% partial file=$which /%}",
      config: {
        variables: { which: "part.md" },
        partials: { "part.md": Markdoc.parse("Top-level child") },
      },
    },
    {
      name: "a nested variable path",
      source: "{% partial file=$selection.which /%}",
      config: {
        variables: { selection: { which: "part.md" } },
        partials: { "part.md": Markdoc.parse("Nested-path child") },
      },
    },
    {
      name: "a partial-local literal variable",
      source: '{% partial file="outer.md" variables={which: "inner.md"} /%}',
      config: {
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped child"),
        },
      },
    },
    {
      name: "a partial-local variable resolved from global scope",
      source: '{% partial file="outer.md" variables={which: $target} /%}',
      config: {
        variables: { target: "inner.md" },
        partials: {
          "outer.md": Markdoc.parse("{% partial file=$which /%}"),
          "inner.md": Markdoc.parse("Scoped global child"),
        },
      },
    },
  ])("accepts a valid partial selected by $name", ({ config, source }) => {
    expect(validateTopikContent(source, { config })).toEqual({ source, valid: true, errors: [] });
  });

  test.each([
    { variables: {}, name: "missing variable" },
    { variables: { which: "missing.md" }, name: "missing target" },
    { variables: { which: 42 }, name: "non-string target" },
  ])("fails a variable-selected partial with a $name closed", ({ variables }) => {
    const source = "{% partial file=$which /%}";
    const result = validateTopikContent(source, {
      config: { variables, partials: { "part.md": Markdoc.parse("Safe") } },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: expect.stringMatching(/^(?:error|critical)$/u) }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(/missing\.md|which|42/u);
  });

  test("does not execute a function transform to select a partial", () => {
    const source = "{% partial file=select() /%}";
    const transform = vi.fn(() => "part.md");
    const result = validateTopikContent(source, {
      config: {
        functions: { select: { returns: String, transform } },
        partials: { "part.md": Markdoc.parse("Safe") },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-partial-invalid" })]),
    );
    expect(transform).not.toHaveBeenCalled();
  });

  test("applies the same invalid closure proof to a variable-selected partial", () => {
    const source = "{% partial file=$selection.which /%}";
    const result = validateTopikContent(source, {
      config: {
        variables: { selection: { which: "bad.md" } },
        partials: { "bad.md": Markdoc.parse("{% quiz %}ordinary child{% /quiz %}") },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "topik-quiz-requires-question" })]),
    );
    expect(JSON.stringify(result.errors)).not.toMatch(/bad\.md|ordinary child/u);
  });

  test.each([
    {
      name: "cyclic closure",
      variables: { selection: { which: "self.md" } },
      partials: { "self.md": Markdoc.parse('{% partial file="self.md" /%}') },
      id: "topik-partial-cycle",
    },
    {
      name: "malformed entry",
      variables: { selection: { which: "bad.md" } },
      partials: { "bad.md": { private: "PRIVATE_VALUE_SENTINEL" } },
      id: "topik-partial-invalid",
    },
  ])("fails a variable-selected $name closed", ({ id, partials, variables }) => {
    const source = "{% partial file=$selection.which /%}";
    const result = validateTopikContent(source, { config: { partials, variables } });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|selection|self\.md|bad\.md/u,
    );
  });

  test("runs additive extension validation once after canonical acceptance", () => {
    const source = '{% notice tone="quiet" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-warning",
        level: "warning" as const,
        message: "PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const result = validateTopikContent(source, {
      config: {
        tags: {
          notice: {
            render: "aside",
            attributes: { tone: { type: String, required: true } },
            validate: extensionValidator,
          },
        },
      },
    });

    expect(result).toMatchObject({ source, valid: true });
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: "extension-warning",
        level: "warning",
        message: "Content validation failed.",
      }),
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    expect(extensionValidator).toHaveBeenCalledOnce();
  });

  test("returns a sanitized blocking extension diagnostic after canonical acceptance", () => {
    const source = '{% notice tone="PRIVATE_VALUE_SENTINEL" /%}';
    const extensionValidator = vi.fn(() => [
      {
        id: "extension-invalid",
        level: "error" as const,
        message: "Rejected PRIVATE_VALUE_SENTINEL",
      },
    ]);
    const result = validateTopikContent(source, {
      config: {
        tags: {
          notice: {
            render: "aside",
            attributes: { tone: { type: String } },
            validate: extensionValidator,
          },
        },
      },
    });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual([
      expect.objectContaining({
        id: "extension-invalid",
        level: "error",
        message: "Content validation failed.",
      }),
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("PRIVATE_VALUE_SENTINEL");
    expect(extensionValidator).toHaveBeenCalledOnce();
  });

  test.each([
    '{% mystery private="opaque" %}\r\nchild\r\n{% /mystery %}',
    'Before {% mystery private="opaque" %}child{% /mystery %} after',
    '{% mystery private="outer" %}\n{% unknown private="inner" %}child{% /unknown %}\n{% /mystery %}',
  ])("retains the exact source when unsupported content is rejected", (source) => {
    const result = validateTopikContent(source);

    expect(result.source).toBe(source);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "tag-undefined", level: "critical" })]),
    );
  });

  test("keeps malformed external reference text out of serialized diagnostics", () => {
    const sentinel = "PRIVATE_VALUE";
    for (const reference of [
      `https://user:${sentinel}@[`,
      `https://user:%50RIVATE_VALUE@[`,
      `hTtPs://user:${sentinel}@[`,
      `https://example.com/?token=${sentinel}#%zz`,
    ]) {
      const result = validateTopikContent(`{% card title="Unsafe" href="${reference}" /%}`);
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result.errors)).not.toContain(sentinel);
      expect(JSON.stringify(result.errors)).not.toContain(reference);
    }
  });

  test.each(unsafeDiagnosticFiles)(
    "normalizes every public Markdoc diagnostic surface for %s",
    (file) => {
      const sentinel = "PRIVATE_VALUE_SENTINEL";
      const source = `{% callout variant="${sentinel}" %}child{% /callout %}`;
      const result = validateTopikContent(source, { file });

      expect(result).toMatchObject({ source, valid: false });
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "attribute-value-invalid",
            file: "lesson.md",
            message: expect.any(String),
          }),
        ]),
      );
      expect(result).not.toHaveProperty("markdocErrors");
      expect(JSON.stringify(result.errors)).not.toContain(sentinel);
      expect(JSON.stringify(result.errors)).not.toContain("SENSITIVE_DIRECTORY");
      expect(JSON.stringify(result.errors)).not.toContain(source);
      expect(JSON.stringify(result.errors)).not.toMatch(
        /FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL/u,
      );
    },
  );

  test.each(["lesson.md", "guides/lesson.md", String.raw`guides\lesson.md`])(
    "preserves safe relative diagnostic label %s",
    (file) => {
      const result = validateTopikContent('{% callout variant="invalid" /%}', { file });
      expect(result.errors[0]?.file).toBe(file);
    },
  );

  test.each(ambiguousDiagnosticFiles)("fails an ambiguous diagnostic label closed", (file) => {
    const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
    const result = validateTopikContent(source, { file });

    expect(result.errors).toEqual([
      expect.objectContaining({ file: "content", message: "An attribute has an invalid value." }),
    ]);
    expect(JSON.stringify(result.errors)).not.toMatch(
      /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL|QUERY_SENTINEL|FRAGMENT_SENTINEL|%2F|%25/iu,
    );
  });

  test.each(roundFourAmbiguousDiagnosticFiles)(
    "fails a Unicode or HTML-ambiguous diagnostic label closed",
    (file) => {
      const source = '{% callout variant="PRIVATE_VALUE_SENTINEL" /%}';
      const result = validateTopikContent(source, { file });

      expect(result.errors).toEqual([
        expect.objectContaining({ file: "content", message: "An attribute has an invalid value." }),
      ]);
      expect(JSON.stringify(result.errors)).not.toMatch(
        /PRIVATE_VALUE_SENTINEL|SENSITIVE_DIRECTORY|FILE_CREDENTIAL_SENTINEL/u,
      );
    },
  );

  test("exports component metadata for the initial schema surface", () => {
    expect(Object.keys(topikComponents).sort()).toEqual([
      "accordion",
      "badge",
      "callout",
      "card",
      "cardGrid",
      "choice",
      "codeBlock",
      "codeGroup",
      "codeTab",
      "explanation",
      "figure",
      "image",
      "inlineCode",
      "link",
      "math",
      "mathInline",
      "mermaid",
      "question",
      "quiz",
      "step",
      "steps",
      "tab",
      "table",
      "tableCell",
      "tableHeader",
      "tableRow",
      "tabs",
      "underline",
    ]);
    expect(topikComponents.callout.attributes?.variant.values).toEqual([
      "info",
      "tip",
      "warning",
      "danger",
    ]);
    expect(topikComponents.cardGrid.attributes?.columns).toMatchObject({ min: 1, max: 4 });
    expect(topikComponents.figure.attributes?.darkSrc).toMatchObject({ type: "string" });
    expect(topikComponents.codeGroup.requiredChildren).toEqual(["codeTab"]);
    expect(topikComponents.math.attributes?.content).toMatchObject({ required: true });
    expect(topikComponents.quiz.allowedChildren).toEqual(["question"]);
  });

  test("validates a representative learning page", () => {
    const result = validateTopikContent(`
# Getting started

{% callout variant="tip" title="Before you start" %}
Read the setup instructions first.
{% /callout %}

{% cardGrid columns=2 %}
{% card title="Install" href="/install" %}
Install the package.
{% /card %}
{% card title="Configure" href="/configure" %}
Configure your first project.
{% /card %}
{% /cardGrid %}

{% tabs %}
{% tab title="pnpm" %}
\`\`\`sh
pnpm install
\`\`\`
{% /tab %}
{% tab title="npm" %}
\`\`\`sh
npm install
\`\`\`
{% /tab %}
{% /tabs %}

{% steps %}
{% step title="Create content" %}
Write your page.
{% /step %}
{% step title="Validate" %}
Run the validator.
{% /step %}
{% /steps %}

{% figure src="hero.png" darkSrc="hero-dark.png" alt="Course dashboard" caption="Dashboard overview" /%}

{% codeGroup %}
{% codeTab title="pnpm" %}
\`\`\`sh
pnpm install
\`\`\`
{% /codeTab %}
{% codeTab title="npm" %}
\`\`\`sh
npm install
\`\`\`
{% /codeTab %}
{% /codeGroup %}

{% math content="E = mc^2" /%}

Inline math: {% mathInline content="x^2" /%}

Use {% underline %}important text{% /underline %}.

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

{% quiz %}
{% question %}
{% choice correct=true %}Topik content is Markdoc-based.{% /choice %}
{% choice %}Topik content is binary.{% /choice %}
{% explanation %}Topik content is authored as Markdown with Markdoc tags.{% /explanation %}
{% /question %}
{% /quiz %}
`);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("validates Markdoc attributes", () => {
    expect(idsFor('{% callout variant="surprise" /%}')).toContain("attribute-value-invalid");
    expect(idsFor('{% callout variant="note" /%}')).toContain("attribute-value-invalid");
    expect(idsFor('{% card href="/docs" /%}')).toContain("attribute-missing-required");
    expect(idsFor('{% figure src="image.png" /%}')).toContain("attribute-missing-required");
    expect(idsFor('{% figure src="image.png" darkSrc="image-dark.png" alt="Image" /%}')).toEqual(
      [],
    );
    expect(idsFor("{% math /%}")).toContain("attribute-missing-required");
    expect(idsFor("{% codeTab %}```ts\nconst x = 1;\n```{% /codeTab %}")).toContain(
      "attribute-missing-required",
    );
    expect(idsFor("{% cardGrid columns=5 /%}")).toContain("topik-columns-range");
    expect(idsFor("[Unsupported](ftp://example.com)")).toContain("link-scheme-unsupported");
    expect(idsFor('{% card title="Unsafe" href="data:text/plain,test" /%}')).toContain(
      "link-scheme-unsafe",
    );
  });

  test.each([
    "http://example.com/a.png",
    "https://user:secret@example.com/a.png",
    "file:///tmp/a.png",
    "data:image/png;base64,AA==",
    "blob:https://example.com/id",
    "javascript:alert(1)",
    "//example.com/a.png",
    "/absolute.png",
    "assets%2fhero.png",
    "é.png",
  ])("rejects unsafe or noncanonical asset reference %s", (reference) => {
    const result = validateTopikContent(`{% figure src="${reference}" alt="Unsafe reference" /%}`);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^TOPIK_(?:ASSET_PATH_INVALID|EXTERNAL_REFERENCE_UNSAFE)$/u),
          level: "error",
        }),
      ]),
    );
  });

  test("accepts canonical local and credential-free HTTPS asset references", () => {
    expect(
      validateTopikContent(
        '{% figure src="assets/caf%C3%A9.png" darkSrc="https://example.com/dark.png?q=1#x" alt="Hero" /%}',
      ),
    ).toMatchObject({ valid: true, errors: [] });
    expect(
      validateTopikContent(
        "![External image](https://example.com/image.png)\n\n[External file](https://example.com/file.pdf)\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("accepts mixed-case credential-free HTTPS in every Asset-capable Markdown form", () => {
    expect(
      validateTopikContent(
        [
          "![Image](HtTpS://example.com/image.png)",
          "[Download](hTTps://example.com/manual.pdf)",
          "<HTTPS://example.com/autolink.pdf>",
          '{% figure src="HTtPs://example.com/light.png" darkSrc="htTPs://example.com/dark.png" alt="Theme" /%}',
        ].join("\n\n"),
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each(['"title (detail)"', "'title (detail)'", "(title detail)"])(
    "accepts image and possible-download references with Markdoc inline title form %s",
    (title) => {
      expect(
        validateTopikContent(`![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`),
      ).toMatchObject({ valid: true, errors: [] });
    },
  );

  test.each([
    '"title \\"detail\\" (v1)"',
    `'title "detail" (v1)'`,
    `(title "detail" v1)`,
    `'title \\'detail\\' "quote"'`,
    `(title \\) detail "quote")`,
    '"title &quot;detail&quot; (v1)"',
    '"title\n&quot;detail&quot; (v1)"',
    '"title \\\\ path"',
    '"title &amp;quot; literal"',
  ])("accepts decoded quotation semantics in inline title form %s", (title) => {
    expect(
      validateTopikContent(`![Hero](hero.png ${title})\n\n[Manual](manual.bin ${title})\n`),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "[HTTP file](http://example.com/file.pdf)",
    "[Mixed HTTP](hTtP://example.com/file.pdf)",
    "<HTtp://example.com/file.pdf>",
    "[Credentialed HTTPS file](https://user:secret@example.com/file.pdf)",
    "<http://example.com/file.pdf>",
    "<https://user:secret@example.com/file.pdf>",
    "<person@example.com> <http://example.com/file.pdf>",
  ])("rejects unsafe HTTP policy in a possible download link: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
      ]),
    });
  });

  test.each([
    "![Mixed HTTP](HtTp://example.com/image.png)",
    "![Mixed credentialed HTTPS](hTtPs://user:secret@example.com/image.png)",
    '{% figure src="HTtp://example.com/image.png" alt="Unsafe" /%}',
    '{% figure src="https://example.com/light.png" darkSrc="hTtPs://user:secret@example.com/dark.png" alt="Unsafe" /%}',
  ])("rejects unsafe mixed-case external media reference: %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE" }),
      ]),
    });
  });

  test("accepts a credential-free HTTPS autolink", () => {
    expect(validateTopikContent("<https://example.com/file.pdf>")).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test.each([
    ["http://example.com/file.pdf", "before"],
    ["http://example.com/file.pdf", "after"],
    ["https://user:secret@example.com/file.pdf", "before"],
    ["https://user:secret@example.com/file.pdf", "after"],
  ])(
    "rejects effective unsafe destination %s when a reference link appears %s",
    (reference, placement) => {
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "link.href" }),
        ]),
      });
    },
  );

  test.each(["before", "after"])(
    "accepts effective credential-free HTTPS destinations when a reference link appears %s",
    (placement) => {
      const reference = "https://example.com/file.pdf";
      const unavailable = "[Unavailable][id]";
      const parsed = `[Download](${reference})`;
      const paragraph =
        placement === "before" ? `${unavailable} ${parsed}` : `${parsed} ${unavailable}`;
      expect(validateTopikContent(`${paragraph}\n\n> [id]: ${reference}`)).toMatchObject({
        valid: true,
        errors: [],
      });
    },
  );

  test.each([
    ["http://example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://user:secret@example.com/hero.png", false, "TOPIK_EXTERNAL_REFERENCE_UNSAFE"],
    ["https://example.com/hero.png", true, undefined],
    ["hero.png", false, "TOPIK_ASSET_PATH_INVALID"],
  ])(
    "applies exact-source and external policy to an unpaired effective image destination %s",
    (reference, valid, diagnosticId) => {
      const source = `![Unavailable][id] ![Hero](${reference})\n\n> [id]: ${reference}`;
      expect(validateTopikContent(source)).toMatchObject(
        valid
          ? { valid: true, errors: [] }
          : {
              valid: false,
              errors: expect.arrayContaining([
                expect.objectContaining({
                  id: diagnosticId,
                  type: "image.src",
                }),
              ]),
            },
      );
    },
  );

  test("rejects Asset references in authoring input and permits generated names for output consumers", () => {
    const generated = `auto-v1-${"a".repeat(52)}`;
    expect(
      validateTopikContent(`{% card title="Asset" href="asset:${generated}" /%}`),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "link-asset-navigation-unsupported" }),
      ]),
    });
    expect(validateTopikContent(`![Compiled](asset:${generated})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED" }),
      ]),
    });
    expect(
      validateTopikContent(`![Compiled](asset:${generated})\n`, {
        allowCompiledAssetReferences: true,
      }),
    ).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("reports malformed reserved generated names with a typed diagnostic", () => {
    expect(validateTopikContent("![Hero](asset:auto-v1-short)\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_REFERENCE_MALFORMED", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "asset:company-logo",
    "asset:auto-v1-short",
    "ASSET:company-logo",
    "asset%3Acompany-logo",
    "%61sset%3Acompany-logo",
    "asset%3Acompany%ZZ",
    "asset&#58;company-logo",
  ])("rejects reserved Asset link spelling %s with a typed diagnostic", (reference) => {
    expect(validateTopikContent(`[Download](${reference})\n`)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          id: "TOPIK_ASSET_REFERENCE_MALFORMED",
          type: "link.href",
        }),
      ]),
    });
  });

  test("rejects a raw non-ASCII reference-style image destination", () => {
    expect(validateTopikContent("![Hero][id]\n\n[id]: é.png\n")).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
    expect(
      validateTopikContent("![Good][good]\n\n[unused]: &eacute;.png\n[good]: good.png\n"),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("does not accept exact-source proof from an unrelated Markdoc attribute", () => {
    const source =
      '![x][id] {% callout title="![x](%C3%A9.png)" %}foo{% /callout %}\n\n> [id]: é.png';
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Hero](&eacute;.png)\n",
    "![Hero][id]\n\n[id]: &eacute;.png\n",
    "![Hero](hero\\.png)\n",
    "![Hero][id]\n\n[id]: hero\\.png\n",
  ])("rejects parser-unescaped source destination bytes in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test.each([
    "![Nested [raw]](é.png)\n",
    "![Nested [entity]](&eacute;.png)\n",
    "![Nested [escaped]](hero\\.png)\n",
    "![Nested [reference]][id]\n\n[id]: é.png\n",
    "![Nested [reference]][id]\n\n[id]: &eacute;.png\n",
    "![Nested [reference]][id]\n\n[id]: hero\\.png\n",
    "[![Nested image](é.png)](manual.bin)\n",
  ])("rejects exact noncanonical destinations behind nested labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind nested labels", () => {
    expect(
      validateTopikContent(
        "![Inline [canonical]](%C3%A9.png)\n\n![Reference [canonical]][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test.each([
    "![Inline `]`](é.png)\n",
    "![Inline `[`](&eacute;.png)\n",
    "![Inline `]`](hero\\.png)\n",
    "![Reference `]`][id]\n\n[id]: é.png\n",
    "![Reference `[`][id]\n\n[id]: &eacute;.png\n",
    "![Reference `]`][id]\n\n[id]: hero\\.png\n",
  ])("rejects exact noncanonical destinations behind code-span labels in %s", (source) => {
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
      ]),
    });
  });

  test("accepts canonical encoded destinations behind code-span labels", () => {
    expect(
      validateTopikContent(
        "![Inline `]`](%C3%A9.png)\n\n![Reference `[`][id]\n\n[id]: %C3%A9.png\n",
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  test("rejects a multiline external entity without borrowing a later escaped construct", () => {
    const source =
      "![Multiline](\n  https://example.com/a&amp;b\n) \\![fake](https://example.com/a&b)";
    expect(validateTopikContent(source)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_EXTERNAL_REFERENCE_UNSAFE", type: "image.src" }),
      ]),
    });
  });

  test("validates exact continuation-line definition destinations independently from titles", () => {
    for (const source of [
      "![Hero][id]\n\n[id]:\n  é.png\n",
      '![Hero][id]\n\n[id]:\n  &eacute;.png\n  "Title"\n',
    ]) {
      expect(validateTopikContent(source)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([
          expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", type: "image.src" }),
        ]),
      });
    }
    expect(validateTopikContent('![Hero][id]\n\n[id]:\n  hero.png\n  "Title"\n')).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  test("validates nested child structure", () => {
    expect(idsFor("{% cardGrid %}\n{% callout /%}\n{% /cardGrid %}")).toContain(
      "topik-card-grid-children",
    );
    expect(idsFor("{% tabs %}\nPlain paragraph\n{% /tabs %}")).toContain("topik-tabs-children");
    expect(idsFor("{% codeGroup %}\n{% callout /%}\n{% /codeGroup %}")).toContain(
      "topik-code-group-children",
    );
    expect(idsFor("{% codeGroup %}\n{% /codeGroup %}")).toContain(
      "topik-code-group-requires-code-tab",
    );
    expect(idsFor('{% codeGroup %}\n{% codeTab title="pnpm" /%}\n{% /codeGroup %}')).toContain(
      "topik-code-tab-requires-fence",
    );
    expect(idsFor("{% steps %}\n{% /steps %}")).toContain("topik-steps-requires-step");
    expect(idsFor("{% quiz %}\n{% /quiz %}")).toContain("topik-quiz-requires-question");
  });

  test("validates parent-only tags", () => {
    expect(idsFor('{% tab title="Standalone" /%}')).toContain("topik-tabs-parent-required");
    expect(idsFor('{% codeTab title="Standalone" /%}')).toContain(
      "topik-code-group-parent-required",
    );
    expect(idsFor('{% step title="Standalone" /%}')).toContain("topik-steps-parent-required");
    expect(idsFor("{% choice %}Standalone{% /choice %}")).toContain(
      "topik-question-parent-required",
    );
    expect(
      idsFor("{% question %}\n{% choice correct=true /%}\n{% choice /%}\n{% /question %}"),
    ).toContain("topik-quiz-parent-required");
  });

  test("validates quiz semantics", () => {
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice correct=true /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-choice-count");
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice /%}\n{% choice /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-single-correct-choice");
    expect(
      idsFor(
        "{% quiz %}\n{% question %}\n{% choice correct=true /%}\n{% choice correct=true /%}\n{% /question %}\n{% /quiz %}",
      ),
    ).toContain("topik-question-single-correct-choice");
    expect(
      idsFor(
        '{% quiz %}\n{% question type="multiple-choice" %}\n{% choice /%}\n{% choice /%}\n{% /question %}\n{% /quiz %}',
      ),
    ).toContain("topik-question-correct-choice-required");
  });

  test("includes parser file and line details in normalized diagnostics", () => {
    const result = validateTopikContent('{% card href="/docs" /%}', { file: "lesson.md" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatchObject({ file: "lesson.md" });
    expect(result.errors[0].lines.length).toBeGreaterThan(0);
  });

  test("sanitizes absolute paths on manually constructed asset diagnostics", () => {
    const sentinel = "SENSITIVE_DIRECTORY";
    const source = "![x](é.png)";
    const result = validateTopikContent(source, { file: `/tmp/${sentinel}/lesson.md` });

    expect(result).toMatchObject({ source, valid: false });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "TOPIK_ASSET_PATH_INVALID", file: "lesson.md" }),
      ]),
    );
    expect(JSON.stringify(result.errors)).not.toContain(sentinel);
    expect(JSON.stringify(result.errors)).not.toContain("/tmp/");
  });

  test("transforms tags to stable renderer component names", () => {
    const ast = Markdoc.parse('{% callout variant="warning" %}Careful{% /callout %}');
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    expect(JSON.stringify(tree)).toContain("TopikCallout");
    expect(JSON.stringify(tree)).toContain("warning");
  });

  test("transforms underline aliases to TopikUnderline", () => {
    const ast = Markdoc.parse("{% underline %}Important{% /underline %} and {% u %}short{% /u %}");
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikUnderline");
    expect(rendered).toContain("Important");
    expect(rendered).toContain("short");
  });

  test("transforms built-in markdown nodes to Topik renderer component names", () => {
    const ast = Markdoc.parse(`
[Docs](/docs)

![Hero](assets/hero.png)

\`\`\`ts
const answer = 42;
\`\`\`

| A | B |
| - | - |
| 1 | 2 |
`);
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikLink");
    expect(rendered).toContain("TopikImage");
    expect(rendered).toContain("TopikCodeBlock");
    expect(rendered).toContain("TopikTable");
    expect(rendered).toContain("TopikTableRow");
    expect(rendered).toContain("TopikTableCell");
    expect(rendered).toContain("TopikTableHeader");
  });

  test("transforms mermaid fences to TopikMermaid", () => {
    const ast = Markdoc.parse("```mermaid\ngraph TD;\n  A-->B;\n```");
    const tree = Markdoc.transform(ast, topikMarkdocConfig);
    const rendered = JSON.stringify(tree);

    expect(rendered).toContain("TopikMermaid");
    expect(rendered).toContain("graph TD");
  });
});
