/**
 * Generators of Topik documents for property tests. Test-only: nothing here is exported by the
 * package entry, so none of it is published.
 *
 * Documents are generated as trees and rendered separately, so fast-check shrinks a failure to
 * a small tree rather than to a cut string. Rendering varies the spellings that writers and the
 * parser budget must handle alike: list markers, tab or space indentation, lazy continuation
 * lines, blank-line placement and tight or spaced tag bodies.
 *
 * Components are generated from the registry's schemas, so a new component is covered as soon
 * as it is registered. `fuzz.test.ts` checks that each one appears in valid documents.
 */
import fc from "fast-check";
import { components, type AttributeDefinition, type ComponentDefinition } from "../registry.js";

export const VARIABLES = { name: "Ada", user: { first: "Ada" }, flag: true } as const;

/** Text whose neighbours writers must keep apart: escapes, brackets, references and controls. */
const WORDS = [
  "a",
  "b c",
  "word",
  "\\[",
  "[",
  "b]",
  "(",
  "2)",
  "1.",
  "#",
  "*",
  "_",
  "~",
  "|",
  "\\*",
  "\u000b",
  "&#x20;",
  "&#xb;",
  "&amp;",
  " ",
] as const;
const CODE = ["c", "a`b", " x ", "{% x %}"] as const;
const HREFS = ["/p", "https://e.test/a?b=1", "#top"] as const;
const IMAGES = ["https://e.test/a.png", "media/a.png"] as const;
const VIDEOS = ["media/intro.mp4", "https://videos.example.com/a.mp4"] as const;
const YOUTUBE = ["https://youtu.be/dQw4w9WgXcQ"] as const;
const TEXT_VALUES = ["Title", "A b", "x &#x20; y", "Step 1"] as const;
const METAS = ["", "js", "js &#x20;", "title &#x20; x", "js &#x9;a", "ts a&#x20;", "sh x"] as const;
const FENCE_LINES = ["x", "a", "", "  b", "{% callout %}", "```"] as const;
const FOOTNOTES = ["1", "note"] as const;

/** Reference labels; escapes and entities are part of a label's identity. */
const LABELS = ["r", "a\\*b", "x&amp;y"] as const;
/** Spellings that match a defined label. Case folds; escapes and entities stay part of it. */
const LABEL_USES = [...LABELS, "R"] as const;
/** Definitions every generated document starts with, so references resolve. */
export const PRELUDE = [
  ...LABELS.map((label) => `[${label}]: /u`),
  "[img]: https://e.test/a.png",
  "",
];

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "mark"; marker: "*" | "_" | "**" | "__" | "~~"; children: Inline[] }
  | { kind: "code"; value: string }
  | { kind: "link"; children: Inline[]; href: string }
  | {
      kind: "reference";
      label: string;
      form: "shortcut" | "collapsed" | "full" | "image";
      children: Inline[];
    }
  | { kind: "autolink"; href: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "footnote"; label: string }
  | { kind: "variable"; path: string }
  | { kind: "tag"; name: string; attributes: string[]; children: Inline[] | null }
  | { kind: "break"; style: "\\" | "  " }
  | { kind: "newline" };

export interface ListItem {
  task: boolean | null;
  children: Block[];
}

export type Block =
  | { kind: "paragraph"; children: Inline[]; lazy: boolean }
  | { kind: "heading"; level: number; children: Inline[]; setext: boolean }
  | { kind: "rule"; marker: string }
  | { kind: "quote"; children: Block[] }
  | {
      kind: "list";
      ordered: boolean;
      marker: string;
      start: number;
      loose: boolean;
      tab: boolean;
      items: ListItem[];
    }
  | { kind: "fence"; fence: "```" | "~~~"; meta: string; lines: string[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "tag"; name: string; attributes: string[]; children: Block[] | null; tight: boolean }
  | { kind: "if"; when: Block[]; otherwise: Block[] | null };

export interface Document {
  blocks: Block[];
  /** Footnote definition bodies, rendered at the end for each label the blocks reference. */
  notes: Block[][];
  /** Blank lines after each block but the last: 0, 1 or 2. */
  gaps: number[];
}

const pick = <T>(values: readonly T[]) => fc.constantFrom(...values);

/** Attribute value spellings chosen from the attribute's schema and name. */
function attributeValue(
  component: string,
  name: string,
  attribute: AttributeDefinition,
): fc.Arbitrary<string> {
  switch (attribute.type) {
    case "boolean":
      return fc.boolean().map(String);
    case "number":
      return fc.integer({ min: attribute.min ?? 1, max: attribute.max ?? 4 }).map(String);
    case "enum":
      return pick(attribute.values).map((value) => `"${value}"`);
    case "string": {
      const role = attribute.assetReference?.role;
      const values =
        component === "youtube" && name === "src"
          ? YOUTUBE
          : role === "video" || (component === "video" && name === "src")
            ? VIDEOS
            : attribute.asset || role
              ? IMAGES
              : name === "href"
                ? HREFS
                : name === "id"
                  ? ["intro", "faq"]
                  : name === "icon"
                    ? ["book"]
                    : name === "content"
                      ? ["x^2", "a + b"]
                      : TEXT_VALUES;
      return pick(values).map((value) => `"${value}"`);
    }
  }
}

function attributes(name: string, definition: ComponentDefinition): fc.Arbitrary<string[]> {
  const entries = Object.entries(definition.attributes).map(([attribute, schema]) => {
    const value = attributeValue(name, attribute, schema).map((value) => `${attribute}=${value}`);
    return schema.required
      ? value.map((value) => [value])
      : fc.option(value).map((value) => (value ? [value] : []));
  });
  return entries.length === 0
    ? fc.constant([])
    : fc.tuple(...entries).map((values) => values.flat());
}

const blockComponents = Object.entries(components).filter(
  ([, definition]) => definition.kind === "block",
);
const inlineComponents = Object.entries(components).filter(
  ([, definition]) => definition.kind === "inline",
);
const topLevel = (entries: [string, ComponentDefinition][]) =>
  entries.filter(([, definition]) => !definition.allowedParents);

interface Arbitraries {
  inline: Inline;
  inlines: Inline[];
  plain: Inline[];
  block: Block;
  blocks: Block[];
  [key: `component:${string}`]: Block;
}

const DEPTH = { maxDepth: 4, depthIdentifier: "topik-document", depthSize: "small" } as const;

const built = fc.letrec((untyped: (key: string) => fc.Arbitrary<unknown>) => {
  // fast-check types `tie` loosely for computed keys: name each key's node type here.
  const tie = <K extends keyof Arbitraries>(key: K) => untyped(key) as fc.Arbitrary<Arbitraries[K]>;
  const inline = tie("inline");
  const inlines = tie("inlines");
  const plain = tie("plain");
  const blocks = tie("blocks");

  const plainInline: fc.Arbitrary<Inline> = fc.oneof(
    pick(WORDS).map((value): Inline => ({ kind: "text", value })),
    pick(CODE).map((value): Inline => ({ kind: "code", value })),
    fc.record({
      kind: fc.constant("mark" as const),
      marker: pick(["*", "**", "~~"] as const),
      children: fc.constant<Inline[]>([{ kind: "text", value: "m" }]),
    }),
  );

  const inlineTags = inlineComponents.map(([name, definition]) =>
    fc.record({
      kind: fc.constant("tag" as const),
      name: fc.constant(name),
      attributes: attributes(name, definition),
      children: definition.children === "none" ? fc.constant(null) : inlines,
    }),
  );

  const fence: fc.Arbitrary<Block> = fc.record({
    kind: fc.constant("fence" as const),
    fence: pick(["```", "~~~"] as const),
    meta: pick(METAS),
    lines: fc.array(pick(FENCE_LINES), { maxLength: 3 }),
  });

  const componentBody = (
    name: string,
    definition: ComponentDefinition,
  ): fc.Arbitrary<Block[] | null> => {
    const { children } = definition;
    if (children === "none") return fc.constant(null);
    if (children === "blocks")
      return definition.selfClosing
        ? fc.option(blocks)
        : blocks.map((value): Block[] | null => value);
    if (children === "inline")
      return inlines.map((children): Block[] => [{ kind: "paragraph", children, lazy: false }]);
    if ("nodes" in children) return fence.map((block) => [block]);
    if (name === "question") return question;
    const allowed = children.components;
    return fc.array(fc.oneof(...allowed.map((child) => tie(`component:${child}`))), {
      minLength: Math.max(1, children.min ?? 1),
      maxLength: 3,
    });
  };

  // A question's choices follow its interaction type, so most generated quizzes are valid.
  const choice = (correct: boolean): fc.Arbitrary<Block> =>
    fc.record({
      kind: fc.constant("tag" as const),
      name: fc.constant("choice"),
      attributes: fc.constant<string[]>(correct ? ["correct=true"] : []),
      children: blocks,
      tight: fc.boolean(),
    });
  const question: fc.Arbitrary<Block[]> = fc
    .tuple(fc.integer({ min: 1, max: 2 }), fc.option(tie("component:explanation")))
    .chain(([wrong, explanation]) =>
      fc
        .tuple(choice(true), ...Array.from({ length: wrong }, () => choice(false)))
        .map((choices): Block[] => [...choices, ...(explanation ? [explanation] : [])]),
    );

  const componentArbitraries = Object.fromEntries(
    Object.entries(components).map(([name, definition]) => [
      `component:${name}`,
      fc.record({
        kind: fc.constant("tag" as const),
        name: fc.constant(name),
        attributes:
          name === "question" ? fc.constant([] as string[]) : attributes(name, definition),
        children: componentBody(name, definition),
        tight: fc.boolean(),
      }),
    ]),
  );

  return {
    ...componentArbitraries,
    plain: fc.array(plainInline, { minLength: 1, maxLength: 3 }),
    inline: fc.oneof(
      DEPTH,
      pick(WORDS).map((value): Inline => ({ kind: "text", value })),
      pick(CODE).map((value): Inline => ({ kind: "code", value })),
      fc.record({
        kind: fc.constant("mark" as const),
        marker: pick(["*", "_", "**", "__", "~~"] as const),
        children: inlines,
      }),
      fc.record({ kind: fc.constant("link" as const), children: inlines, href: pick(HREFS) }),
      fc.record({
        kind: fc.constant("reference" as const),
        label: pick(LABEL_USES),
        form: pick(["shortcut", "collapsed", "full", "image"] as const),
        children: inlines,
      }),
      fc.record({
        kind: fc.constant("autolink" as const),
        href: pick(["https://e.test", "a@b.test", "https://e.test/&amp;"]),
      }),
      fc.record({
        kind: fc.constant("image" as const),
        alt: pick(["", "Logo"]),
        src: pick(IMAGES),
      }),
      fc.record({ kind: fc.constant("footnote" as const), label: pick(FOOTNOTES) }),
      fc.record({ kind: fc.constant("variable" as const), path: pick(["name", "user.first"]) }),
      fc.record({ kind: fc.constant("break" as const), style: pick(["\\", "  "] as const) }),
      fc.constant<Inline>({ kind: "newline" }),
      ...inlineTags,
    ),
    inlines: fc.array(inline, { minLength: 1, maxLength: 4 }),
    block: fc.oneof(
      DEPTH,
      fc.record({ kind: fc.constant("paragraph" as const), children: inlines, lazy: fc.boolean() }),
      fc.record({
        kind: fc.constant("heading" as const),
        level: fc.integer({ min: 1, max: 6 }),
        children: plain,
        setext: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant("rule" as const),
        marker: pick(["***", "---", "___", "* * *"]),
      }),
      fc.record({ kind: fc.constant("quote" as const), children: blocks }),
      fc.record({
        kind: fc.constant("list" as const),
        ordered: fc.boolean(),
        marker: pick(["-", "*", "+", ".", ")"]),
        start: fc.integer({ min: 0, max: 3 }),
        loose: fc.boolean(),
        tab: fc.boolean(),
        items: fc.array(
          fc.record({ task: fc.option(fc.boolean()), children: fc.oneof(fc.constant([]), blocks) }),
          { minLength: 1, maxLength: 3 },
        ),
      }),
      fence,
      fc.record({
        kind: fc.constant("table" as const),
        header: fc.array(plain, { minLength: 1, maxLength: 3 }),
        rows: fc.array(fc.array(plain, { minLength: 1, maxLength: 3 }), { maxLength: 2 }),
      }),
      fc.record({ kind: fc.constant("if" as const), when: blocks, otherwise: fc.option(blocks) }),
      ...topLevel(blockComponents).map(([name]) => tie(`component:${name}`)),
    ),
    blocks: fc.array(tie("block"), { minLength: 1, maxLength: 3 }),
  };
});

/** The generators, tied together so components can nest each other. */
export const arbitraries = built as unknown as {
  [K in keyof Arbitraries]: fc.Arbitrary<Arbitraries[K]>;
};

export const document: fc.Arbitrary<Document> = arbitraries.blocks.chain((blocks) =>
  fc.record({
    blocks: fc.constant(blocks),
    // Footnote bodies are paragraphs: definitions admit no nested footnotes or components.
    notes: fc.array(
      arbitraries.inlines.map((children): Block[] => [
        { kind: "paragraph", children, lazy: false },
      ]),
      { minLength: FOOTNOTES.length, maxLength: FOOTNOTES.length },
    ),
    gaps: fc.array(fc.constantFrom(1, 1, 1, 0, 2), {
      minLength: Math.max(0, blocks.length - 1),
      maxLength: Math.max(0, blocks.length - 1),
    }),
  }),
);

/** A rendered line; a lazy line may skip the container prefixes of the blocks around it. */
interface Line {
  text: string;
  lazy: boolean;
}

function renderInlines(children: readonly Inline[]): string {
  return children.map(renderInline).join("");
}

function renderInline(node: Inline): string {
  switch (node.kind) {
    case "text":
      return node.value;
    case "mark":
      return `${node.marker}${renderInlines(node.children)}${node.marker}`;
    case "code":
      return node.value.includes("`") ? `\`\` ${node.value} \`\`` : `\`${node.value}\``;
    case "link":
      return `[${renderInlines(node.children)}](${node.href})`;
    case "reference":
      switch (node.form) {
        case "shortcut":
          return `[${node.label}]`;
        case "collapsed":
          return `[${node.label}][]`;
        case "full":
          return `[${renderInlines(node.children)}][${node.label}]`;
        case "image":
          return `![${node.label}][img]`;
      }
    case "autolink":
      return `<${node.href}>`;
    case "image":
      return `![${node.alt}](${node.src})`;
    case "footnote":
      return `[^${node.label}]`;
    case "variable":
      return `{% $${node.path} %}`;
    case "tag": {
      const open = [node.name, ...node.attributes].join(" ");
      return node.children === null
        ? `{% ${open} /%}`
        : `{% ${open} %}${renderInlines(node.children)}{% /${node.name} %}`;
    }
    case "break":
      return `${node.style}\n`;
    case "newline":
      return "\n";
  }
}

function joinBlocks(blocks: readonly Block[], gaps?: readonly number[]): Line[] {
  const lines: Line[] = [];
  blocks.forEach((block, index) => {
    if (index)
      for (let gap = gaps?.[index - 1] ?? 1; gap > 0; gap--) lines.push({ text: "", lazy: false });
    lines.push(...renderBlock(block));
  });
  return lines;
}

/** Prefix every line that is not lazy; blank lines take the prefix without trailing spaces. */
function prefixed(lines: readonly Line[], first: string, rest: string): Line[] {
  return lines.map((line, index) => {
    if (index === 0) return { text: first + line.text, lazy: false };
    if (line.lazy) return line;
    return { text: line.text ? rest + line.text : rest.trimEnd(), lazy: false };
  });
}

function renderBlock(block: Block): Line[] {
  switch (block.kind) {
    case "paragraph":
      return renderInlines(block.children)
        .split("\n")
        .map((text, index) => ({ text, lazy: block.lazy && index > 0 }));
    case "heading": {
      const text = renderInlines(block.children).replace(/\n/gu, " ");
      if (block.setext && block.level <= 2)
        return [
          { text, lazy: false },
          { text: block.level === 1 ? "===" : "---", lazy: false },
        ];
      return [{ text: `${"#".repeat(block.level)} ${text}`, lazy: false }];
    }
    case "rule":
      return [{ text: block.marker, lazy: false }];
    case "quote":
      return prefixed(joinBlocks(block.children), "> ", "> ");
    case "list": {
      const lines: Line[] = [];
      block.items.forEach((item, index) => {
        if (index && block.loose) lines.push({ text: "", lazy: false });
        const bullet = block.ordered
          ? `${block.start + index}${block.marker === ")" ? ")" : "."}`
          : [".", ")"].includes(block.marker)
            ? "-"
            : block.marker;
        const task = item.task === null ? "" : item.task ? "[x] " : "[ ] ";
        if (item.children.length === 0) {
          lines.push({ text: bullet, lazy: false });
          return;
        }
        const body = joinBlocks(item.children);
        if (task && item.children[0].kind === "paragraph")
          body[0] = { ...body[0], text: task + body[0].text };
        lines.push(
          ...prefixed(body, `${bullet} `, block.tab ? "\t" : " ".repeat(bullet.length + 1)),
        );
      });
      return lines;
    }
    case "fence": {
      const runs = block.lines.map(
        (line) => line.match(block.fence[0] === "`" ? /`+/gu : /~+/gu) ?? [],
      );
      const longest = Math.max(0, ...runs.flat().map((run) => run.length));
      const fence = block.fence[0].repeat(Math.max(3, longest + 1));
      return [`${fence}${block.meta}`, ...block.lines, fence].map((text) => ({
        text,
        lazy: false,
      }));
    }
    case "table": {
      const width = block.header.length;
      const row = (cells: readonly Inline[][]) =>
        `| ${Array.from({ length: width }, (_, index) =>
          renderInlines(cells[index] ?? [{ kind: "text", value: "a" }])
            .replace(/\n/gu, " ")
            // Escape backslashes too, so a cell's trailing backslash cannot escape the pipe.
            .replace(/[\\|]/gu, "\\$&"),
        ).join(" | ")} |`;
      return [row(block.header), `|${" - |".repeat(width)}`, ...block.rows.map(row)].map(
        (text) => ({ text, lazy: false }),
      );
    }
    case "tag": {
      const open = [block.name, ...block.attributes].join(" ");
      if (block.children === null) return [{ text: `{% ${open} /%}`, lazy: false }];
      const gap: Line[] = block.tight ? [] : [{ text: "", lazy: false }];
      return [
        { text: `{% ${open} %}`, lazy: false },
        ...gap,
        ...joinBlocks(block.children),
        ...gap,
        { text: `{% /${block.name} %}`, lazy: false },
      ];
    }
    case "if": {
      const lines: Line[] = [
        { text: "{% if $flag %}", lazy: false },
        { text: "", lazy: false },
        ...joinBlocks(block.when),
      ];
      if (block.otherwise)
        lines.push(
          { text: "", lazy: false },
          { text: "{% else /%}", lazy: false },
          { text: "", lazy: false },
          ...joinBlocks(block.otherwise),
        );
      lines.push({ text: "", lazy: false }, { text: "{% /if %}", lazy: false });
      return lines;
    }
  }
}

/** Render a generated document, with the definitions its references and footnotes need. */
export function render(document: Document): string {
  const body = joinBlocks(document.blocks, document.gaps).map((line) => line.text);
  const text = body.join("\n");
  const notes = FOOTNOTES.flatMap((label, index) =>
    text.includes(`[^${label}]`)
      ? [
          "",
          ...prefixed(joinBlocks(document.notes[index]), `[^${label}]: `, "    ").map(
            (line) => line.text,
          ),
        ]
      : [],
  );
  return [...PRELUDE, ...body, ...notes].join("\n");
}

/** Rendered documents, the input of the round-trip properties. */
export const source: fc.Arbitrary<string> = document.map(render);

/**
 * Lines that need not form a valid document, for the parser budget: container prefixes,
 * indentation, underlines, footnote definitions, tag lines and blank or lazy lines, in the
 * combinations that once made the parser's work grow with the square of the document.
 */
const PREFIXES = ["> ", "- ", "* ", "1. ", "2) ", "\t", "  ", "    ", "-", "[^1]: "] as const;
const CONTENTS = [
  "a",
  "Title",
  "===",
  "---",
  "* * *",
  "[^1]",
  "[r]",
  "*a",
  "`",
  "```",
  "| a | b |",
  "| - | - |",
  "{% callout %}",
  "{% /callout %}",
  "{% tabs %}",
  '{% tab title="A" %}',
  "",
] as const;
export const soupLine = fc
  .tuple(fc.array(pick(PREFIXES), { maxLength: 3 }), pick(CONTENTS))
  .map(([prefixes, content]) => prefixes.join("") + content);
export const soupUnit = fc
  .array(soupLine, { minLength: 1, maxLength: 6 })
  .map((lines) => `${lines.join("\n")}\n`);

/**
 * Short units of nested containers over plain text, the shapes the container cost model
 * describes: a line that opens, continues or closes quotes, lists and footnotes.
 */
const CONTAINERS = ["> ", "- ", "* ", "1. ", "2) ", "  ", "\t", "[^1]: "] as const;
export const containerUnit = fc
  .array(
    fc
      .tuple(
        fc.array(pick(CONTAINERS), { maxLength: 3 }),
        pick(["a", "a", "Title", "===", "---", ""]),
      )
      .map(([prefixes, content]) => prefixes.join("") + content),
    { minLength: 1, maxLength: 3 },
  )
  .map((lines) => `${lines.join("\n")}\n`);

/** A small unit to repeat: nested containers, line soup, or a valid-biased document. */
export const budgetUnit = fc.oneof(
  { arbitrary: containerUnit, weight: 3 },
  { arbitrary: soupUnit, weight: 2 },
  {
    arbitrary: document.map(
      (doc) =>
        `${joinBlocks(doc.blocks, doc.gaps)
          .map((line) => line.text)
          .join("\n")}\n\n`,
    ),
    weight: 1,
  },
);
