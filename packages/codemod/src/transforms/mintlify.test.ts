import { parseTopikContent, validateTopikContent } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

function converted(source: string): string {
  const result = transformMintlify(source);
  expect(result.warnings).toEqual([]);
  expect(result.changed).toBe(true);
  expect(validateTopikContent(result.content)).toMatchObject({ valid: true, errors: [] });
  return result.content;
}

describe("Mintlify to Topik content", () => {
  test.each([
    ["Note", "info"],
    ["Info", "info"],
    ["Tip", "tip"],
    ["Check", "tip"],
    ["Warning", "warning"],
    ["Danger", "danger"],
  ])("converts <%s> to a block callout with variant %s", (name, variant) => {
    const output = converted(`<${name}>Heads up</${name}>\n`);
    expect(output).toBe(`{% callout variant="${variant}" %}\nHeads up\n{% /callout %}\n`);
    expect(parseTopikContent(output).children[0]).toMatchObject({
      type: "topikComponent",
      name: "callout",
      props: { variant },
    });
  });

  test("converts nested canonical components with camelCase names and own-line tags", () => {
    const source = [
      '<CardGroup columns="2">',
      '<Card title="First" href="/first" />',
      "</CardGroup>",
      '<Tabs><Tab title="CLI">Use it.</Tab></Tabs>',
      '<Steps><Step title="Install">Run it.</Step></Steps>',
      '<Accordion title="More">Details.</Accordion>',
    ].join("\n");
    const output = converted(source);
    expect(output).toContain(
      '{% cardGrid columns=2 %}\n{% card title="First" href="/first" /%}\n{% /cardGrid %}',
    );
    expect(output).toContain('{% tabs %}\n{% tab title="CLI" %}\nUse it.\n{% /tab %}\n{% /tabs %}');
    expect(output).toContain(
      '{% steps %}\n{% step title="Install" %}\nRun it.\n{% /step %}\n{% /steps %}',
    );
  });

  test("preserves quoted values and converts typed literals", () => {
    const output = converted(
      `<Card title='say "hi"' href="/next" />\n<Accordion title="More" open="true">Details.</Accordion>`,
    );
    expect(output).toContain('title="say \\"hi\\""');
    expect(output).toContain("open=true");
    expect(parseTopikContent(output).children[1]).toMatchObject({
      type: "topikComponent",
      name: "accordion",
      props: { open: true },
    });
  });

  test.each([
    '<Frame caption="Image">![alt](image.png)</Frame>',
    '<Icon icon="star" />',
    '<AccordionGroup><Accordion title="A">Body</Accordion></AccordionGroup>',
    "<Card title={name} />",
    '<Card title="Safe" icon={Icon} />',
    '<Card title="Safe" unknown="value" />',
    "<CodeGroup>```js\nhello\n```</CodeGroup>",
    '<Tab title="Orphan">Body</Tab>',
    '<Card title="One" title="Two" />',
  ])("keeps unsupported source unchanged with a warning: %s", (source) => {
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("does not publish partial conversion when a file has unsupported source", () => {
    const source = '<Note>Helpful.</Note>\n<Icon icon="star" />';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("warns at the offending dynamic attribute", () => {
    const source = '<Card title="Safe" icon={Icon} />';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({ line: 1, column: 20, message: expect.stringContaining("Dynamic") }),
    ]);
  });

  test("finds a quoted > without misreading a tag boundary", () => {
    const output = converted('<Card title="x>y" />');
    expect(output).toContain('title="x>y"');
  });

  test.each(["\n", "\r\n"])("preserves frontmatter bytes with %j line endings", (eol) => {
    const frontmatter = [
      "--- \t",
      '# Keep spacing and quotes: "<Note>example</Note>"',
      'title: "<Note>Important</Note>"',
      "description: |",
      "  <Warning>Metadata, not JSX.</Warning>",
      "sample: |",
      "  ```mdx",
      "  <Note>Unclosed example fence</Note>",
      "---\t ",
      "",
      "",
    ].join(eol);

    const metadataOnly = `${frontmatter}# Hello${eol}`;
    expect(transformMintlify(metadataOnly)).toEqual({
      content: metadataOnly,
      warnings: [],
      changed: false,
    });

    const mixed = `${frontmatter}<Note>Body.</Note>${eol}`;
    const output = converted(mixed);
    expect(output.slice(0, frontmatter.length)).toBe(frontmatter);
    expect(output.slice(frontmatter.length)).toBe(
      `{% callout variant="info" %}${eol}Body.${eol}{% /callout %}${eol}`,
    );
  });

  test.each(["---\n---\n", "---\r\n---\r\n", '---\ntitle: "<Note>Metadata</Note>"\n---'])(
    "preserves empty headers and a header ending at EOF: %j",
    (source) => {
      expect(transformMintlify(source)).toEqual({ content: source, warnings: [], changed: false });
    },
  );

  test("reports body warning locations relative to the complete source", () => {
    const source = '---\ntitle: "<Note>Metadata</Note>"\n---\n\n<Card title={name} />\n';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({ line: 5, column: 7, message: expect.stringContaining("Dynamic") }),
    ]);
  });

  test("leaves code fences, inline code and plain Markdown intact", () => {
    for (const source of [
      "```mdx\n<Note>example</Note>\n```\n",
      "~~~mdx\n<Note>example</Note>\n~~~\n",
      "````mdx\n<Note>example</Note>\n````\n",
      "Use the `<Note>` component.\n",
      "Use the ``<Note>`` component.\n",
      "# Hello\n\nJust regular Markdown.\n",
    ]) {
      expect(transformMintlify(source)).toEqual({ content: source, warnings: [], changed: false });
    }
  });

  const literalExamples = [
    ["quoted fence", "> ```mdx\n> <Note>example</Note>\n> ```\n"],
    ["list fence", "- ```mdx\n  <Note>example</Note>\n  ```\n"],
    ["ordered-list fence", "12. ~~~mdx\n    <Note>example</Note>\n    ~~~\n"],
    ["quoted list fence", "> - ```mdx\n>   <Note>example</Note>\n>   ```\n"],
    ["list quoted fence", "- > ```mdx\n  > <Note>example</Note>\n  > ```\n"],
    ["nested quote fence", "> > ```mdx\n> > <Note>example</Note>\n> > ```\n"],
    ["nested list fence", "- Outer\n  - ```mdx\n    <Note>example</Note>\n    ```\n"],
    ["shorter and different fences", "````mdx\n```\n<Note>example</Note>\n~~~\n````\n"],
    ["indented code", "    <Note>example</Note>\n"],
    ["quoted indented code", ">     <Note>example</Note>\n"],
    ["list indented code", "- Item\n\n      <Note>example</Note>\n"],
    ["inline code", "Use `<Note>example</Note>` and `<Icon />`.\n"],
    ["multiple backticks", "Use ``a ` <Note>example</Note> ` b``.\n"],
  ];

  test.each(literalExamples)("preserves %s and converts following JSX", (_name, literal) => {
    for (const eol of ["\n", "\r\n"]) {
      const prefix = `${literal}\n`.replaceAll("\n", eol);
      expect(transformMintlify(prefix)).toEqual({ content: prefix, warnings: [], changed: false });
      expect(converted(`${prefix}<Note>Real.</Note>\n`)).toBe(
        `${prefix}{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
      );
    }
  });

  const markdownResources = [
    ["double-quoted link title", '[Docs](./intro "`<Note>literal</Note>`")'],
    ["single-quoted link title", "[Docs](./intro '`<Note>literal</Note>`')"],
    ["parenthesized link title", "[Docs](./intro (`<Note>literal</Note>`))"],
    ["plain link-title metadata", '[Docs](./intro "<Note>literal</Note>")'],
    ["image alt", "![Use `<Note>literal</Note>`](img.png)"],
    ["image title", '![Example](img.png "`<Note>literal</Note>`")'],
    ["reference image alt", "![Use `<Note>literal</Note>`][pic]\n\n[pic]: img.png\n"],
    ["reference title", '[ref]: ./intro "`<Note>literal</Note>`"\n\n[Docs][ref]'],
    ["reference label", "[Docs][`<Note>literal</Note>`]\n\n[`<Note>literal</Note>`]: ./intro\n"],
    ["angle-bracket destination", "[Docs](<Note>)"],
    ["unsupported component in image alt", "![Use `<Icon />`](img.png)"],
    ["unsupported component in link title", '[Docs](./intro "`<Icon />`")'],
    ["linked image", '[![Use `<Note>literal</Note>`](img.png)](./intro "`<Icon />`")'],
  ];

  test.each(markdownResources)("preserves %s and migrates adjacent body JSX", (_name, resource) => {
    for (const eol of ["\n", "\r\n"]) {
      for (const header of ["", `\uFEFF---${eol}title: "Example"${eol}---${eol}${eol}`]) {
        const prefix = `${header}${resource.replaceAll("\n", eol)}`;
        const original = `${prefix}${eol}`;
        expect(validateTopikContent(original).valid).toBe(true);
        expect(transformMintlify(original)).toEqual({
          content: original,
          warnings: [],
          changed: false,
        });
        // Definition fixtures include their terminating newline; JSX directly
        // follows inline resources to exercise the protected range boundary.
        const output = converted(`${prefix}<Note>Real.</Note>\n`);
        expect(output).toBe(
          `${prefix}${prefix.endsWith("\n") ? "" : "\n"}{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
        );
      }
    }
  });

  test("preserves link metadata inside a converted JSX body", () => {
    const link = '[Docs](./intro "`<Note>literal</Note>`")';
    expect(converted(`<Note>${link}</Note>\n`)).toBe(
      `{% callout variant="info" %}\n${link}\n{% /callout %}\n`,
    );
  });

  test("keeps unsupported JSX in link labels on the validation warning path", () => {
    const source = "[<Note>Label.</Note>](./intro)\n\n<Note>Body.</Note>\n";
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("not valid Topik content; source kept"),
      }),
    ]);
  });

  test.each(["` unmatched ", "\\` escaped ", "`` unmatched with ` "])(
    "does not treat %j backticks as code",
    (prefix) => {
      expect(converted(`${prefix}<Note>Real.</Note>\n`)).toBe(
        `${prefix}\n{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
      );
    },
  );

  test("preserves the remainder of an unclosed fenced code block", () => {
    const source = "> ```mdx\n> <Note>example</Note>\n> <Icon />\n";
    expect(transformMintlify(source)).toEqual({ content: source, warnings: [], changed: false });
  });

  test.each([
    ["<Note>", "</Note>"],
    ['<Tabs>\n<Tab title="Example">', "</Tab>\n</Tabs>"],
  ])("finds literal code inside JSX wrappers: %s", (open, close) => {
    const literal = "```mdx\n<Note>example</Note>\n<Icon />\n```\n";
    const output = converted(`${open}\n${literal}<Note>Real.</Note>\n${close}\n`);
    expect(output).toContain(literal);
    expect(output).toContain('{% callout variant="info" %}\nReal.\n{% /callout %}');
  });

  test("finds inline code inside JSX bodies", () => {
    const literal = "Use `<Note>example</Note>` and ``first ` <Icon /> ` last``.";
    const output = converted(`<Note>${literal}</Note>\n`);
    expect(output).toBe(`{% callout variant="info" %}\n${literal}\n{% /callout %}\n`);
  });

  test("does not pair backticks across quoted JSX attributes", () => {
    const source = '<Card title="`" /><Note>Body.</Note><Card title="`" />';
    expect(converted(source)).toBe(
      '{% card title="`" /%}\n{% callout variant="info" %}\nBody.\n{% /callout %}\n{% card title="`" /%}\n',
    );
  });

  test.each(["`", "``"])(
    "preserves multiline %s code spans when target validation refuses them",
    (ticks) => {
      for (const eol of ["\n", "\r\n"]) {
        const literal = `Use ${ticks}first\n<Note>example</Note>\n<Icon />\nlast${ticks}.\n`;
        for (const source of [
          literal,
          `<Note>${literal}</Note>\n`,
          `${literal}\n<Note>Real.</Note>\n`,
        ]) {
          const original = source.replaceAll("\n", eol);
          const result = transformMintlify(original);
          expect(result).toMatchObject({ content: original, changed: false });
          // Topik currently rejects newlines in inlineCode values. Keep that
          // validation boundary without interpreting literal JSX as components.
          expect(result.warnings).toEqual([
            expect.objectContaining({
              message: expect.stringContaining("not valid Topik content; source kept"),
            }),
          ]);
        }
      }
    },
  );

  test("keeps unknown JSX wrappers unchanged even when they contain code", () => {
    const source =
      "<CustomThing>\n```mdx\n<Note>example</Note>\n```\n<Note>Real.</Note>\n</CustomThing>\n";
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("warns on unsupported raw JSX even without a recognized convertible tag", () => {
    const source = '<CustomThing title="x" />';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("migration preserves Markdown context and JSX attribute values", () => {
  test.each([1, 3])("preserves tags escaped by %s backslashes", (count) => {
    const slashes = "\\".repeat(count);
    const literal = `${slashes}<Note>literal${slashes}</Note>\n`;
    expect(transformMintlify(literal)).toEqual({ content: literal, warnings: [], changed: false });
    const output = converted(`${literal}\n<Note>Actual.</Note>\n`);
    expect(output).toBe(`${literal}\n{% callout variant="info" %}\nActual.\n{% /callout %}\n`);
  });

  test.each([2, 4])("converts tags after %s backslashes", (count) => {
    const slashes = "\\".repeat(count);
    const output = converted(`${slashes}<Note>Actual.</Note>\n`);
    expect(output).toBe(`${slashes}\n{% callout variant="info" %}\nActual.\n{% /callout %}\n`);
  });

  test.each([
    "> <Note>Text.</Note>\n",
    "- <Note>Text.</Note>\n",
    "1. <Note>Text.</Note>\n",
    "> - <Note>Text.</Note>\n",
    "- Item\n\n  <Note>\n  Text.\n  </Note>\n",
    "> <Note>\n> Text.\n> </Note>\n",
  ])("keeps container-nested JSX transactionally: %j", (nested) => {
    for (const source of [nested, `<Note>Before.</Note>\n\n${nested}\n<Note>After.</Note>\n`]) {
      for (const eol of ["\n", "\r\n"]) {
        const original = source.replaceAll("\n", eol);
        const result = transformMintlify(original);
        expect(result).toMatchObject({ content: original, changed: false });
        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("Markdown list or blockquote"),
          }),
        );
      }
    }
  });

  test.each(['"', "'"])("preserves literal backslashes in %s JSX attributes", (quote) => {
    for (const value of [
      String.raw`Literal \u0041 and \\server`,
      String.raw`C:\new\test`,
      "trailing\\",
    ]) {
      const output = converted(`<Card title=${quote}${value}${quote} />`);
      expect(parseTopikContent(output).children[0]).toMatchObject({
        type: "topikComponent",
        name: "card",
        props: { title: value },
      });
    }
  });

  test("recognizes a body after a quoted attribute ending in a backslash", () => {
    const source = '<Note title="Trailing\\">\n`<Note>literal</Note>`\n</Note>\n';
    const output = converted(source);
    expect(output).toContain("`<Note>literal</Note>`");
    expect(parseTopikContent(output).children[0]).toMatchObject({
      type: "topikComponent",
      name: "callout",
      props: { title: "Trailing\\" },
    });
  });
});

test("escaped unsupported components remain literal while genuine JSX migrates", () => {
  const source = String.raw`\<Icon />` + "\n\n<Note>Actual.</Note>\n";
  expect(converted(source)).toBe(
    String.raw`\<Icon />` + '\n\n{% callout variant="info" %}\nActual.\n{% /callout %}\n',
  );
});

describe("indented Mintlify bodies", () => {
  type Node = { type: string; name?: string; value?: string; children?: Node[] };
  const shape = (node: Node): unknown =>
    node.type === "topikComponent"
      ? { [node.name!]: node.children!.map(shape) }
      : node.type === "code"
        ? { code: node.value }
        : node.type === "list"
          ? { list: node.children!.map((item) => item.children!.map(shape)) }
          : node.type;
  const tree = (output: string) => (parseTopikContent(output).children as Node[]).map(shape);

  test.each(["  ", "    ", "\t"])("dedents nested component bodies indented by %j", (unit) => {
    const indent = (depth: number) => unit.repeat(depth);
    const source = [
      "<Steps>",
      `${indent(1)}<Step title="A">`,
      `${indent(2)}Some text here`,
      `${indent(2)}continued.`,
      "",
      `${indent(2)}<Note>`,
      `${indent(3)}Nested.`,
      `${indent(2)}</Note>`,
      `${indent(1)}</Step>`,
      "</Steps>",
      "",
    ].join("\n");
    const output = converted(source);
    expect(output).toBe(
      [
        "{% steps %}",
        '{% step title="A" %}',
        "Some text here",
        "continued.",
        "",
        '{% callout variant="info" %}',
        "Nested.",
        "{% /callout %}",
        "{% /step %}",
        "{% /steps %}",
        "",
      ].join("\n"),
    );
    expect(tree(output)).toEqual([
      { steps: [{ step: ["paragraph", { callout: ["paragraph"] }] }] },
    ]);
  });

  test.each(["  ", "    "])("keeps indented fences inside tabs as fenced code (%j)", (unit) => {
    const source = [
      "<Tabs>",
      `${unit}<Tab title="JS">`,
      `${unit}${unit}\`\`\`js`,
      `${unit}${unit}if (ok) {`,
      `${unit}${unit}  run();`,
      "}",
      `${unit}${unit}\`\`\``,
      `${unit}</Tab>`,
      "</Tabs>",
      "",
    ].join("\n");
    const output = converted(source);
    expect(output).toContain(
      '{% tab title="JS" %}\n```js\nif (ok) {\n  run();\n}\n```\n{% /tab %}',
    );
    expect(tree(output)).toEqual([{ tabs: [{ tab: [{ code: "if (ok) {\n  run();\n}" }] }] }]);
  });

  test("preserves relative indentation of lists inside components", () => {
    const source = [
      '<Accordion title="More">',
      "    - First",
      "        - Nested",
      "",
      "      Item paragraph.",
      "    - Second",
      "</Accordion>",
      "",
    ].join("\n");
    const output = converted(source);
    expect(output).toContain("- First\n    - Nested\n\n  Item paragraph.\n- Second\n");
    expect(tree(output)).toEqual([
      {
        accordion: [
          { list: [["paragraph", { list: [["paragraph"]] }, "paragraph"], ["paragraph"]] },
        ],
      },
    ]);
  });

  test("dedents a same-line body and the text before a close tag", () => {
    const output = converted("<Note>First line\n    second line\n    last.</Note>\n");
    expect(output).toBe(
      '{% callout variant="info" %}\nFirst line\nsecond line\nlast.\n{% /callout %}\n',
    );
  });

  test("leaves indented top-level tags that Markdown reads as code untouched", () => {
    const literal = "    <Note>\n      Example.\n    </Note>\n";
    expect(transformMintlify(literal)).toEqual({ content: literal, warnings: [], changed: false });
    expect(converted(`${literal}\n<Note>\n  Real.\n</Note>\n`)).toBe(
      `${literal}\n{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
    );
  });

  test.each([
    ["mixed line indentation", "<Note>\n\tTab line.\n    Space line.\n</Note>\n", 3],
    ["mixed fence contents", "<Tab title='x'>\n    ```\n\tcode\n    ```\n</Tab>\n", 3],
  ])("refuses ambiguous %s and reports its location", (_name, source, line) => {
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      { line, column: 1, message: expect.stringContaining("mixes tabs and spaces") },
    ]);
  });

  test("reports warnings inside dedented bodies at their source columns", () => {
    const source = "<Note>\n    <Card title={x} />\n</Note>\n";
    expect(transformMintlify(source).warnings).toEqual([
      expect.objectContaining({ line: 2, column: 11, message: expect.stringContaining("Dynamic") }),
    ]);
  });
});

describe("line endings", () => {
  test.each([
    [
      "<Note>\r\nHello\r\n</Note>\r\n",
      '{% callout variant="info" %}\r\nHello\r\n{% /callout %}\r\n',
    ],
    ["<Note>Hello</Note>\r\n", '{% callout variant="info" %}\r\nHello\r\n{% /callout %}\r\n'],
    [
      '<Tabs>\r\n  <Tab title="A">\r\n    Body\r\n  </Tab>\r\n</Tabs>',
      '{% tabs %}\r\n{% tab title="A" %}\r\nBody\r\n{% /tab %}\r\n{% /tabs %}\r\n',
    ],
  ])("keeps CRLF line endings consistent: %j", (source, expected) => {
    expect(converted(source)).toBe(expected);
  });
});

describe("validation failures", () => {
  test("pass through target diagnostics at their source lines", () => {
    const source = '# Title\n\n<Tab title="Orphan">\nBody\n</Tab>\n';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const warning of result.warnings) {
      expect(warning.message).toMatch(
        /^Converted content is not valid Topik content; source kept: .+ \[[a-z0-9-]+\]/u,
      );
      expect(warning.line).toBe(3);
    }
  });
});

describe("MDX-only syntax", () => {
  test.each([
    ["import", "import { Thing } from '/snippets/thing.mdx'\n\n# Title\n", 1, 1, "import/export"],
    ["export", "# Title\n\nexport const name = 'x'\n", 3, 1, "import/export"],
    ["flow expression", "# Title\n\n{/* comment */}\n", 3, 1, "expressions"],
    ["inline expression", "Hello {user.name}!\n", 1, 7, "expressions"],
    ["expression in a body", "<Note>\n  Value: {1 + 1}\n</Note>\n", 2, 10, "expressions"],
    ["expression in a link label", "[{1 + 1}](./page)\n", 1, 2, "expressions"],
    ["expression in a nested link label", "[See *{name}*](./page)\n", 1, 7, "expressions"],
    [
      "expression in a reference link label",
      "[Total {n}][ref]\n\n[ref]: ./page\n",
      1,
      8,
      "expressions",
    ],
    ["expression in image alt text", "![{alt}](./img.png)\n", 1, 3, "expressions"],
    [
      "expression in reference image alt",
      "![Logo {x}][pic]\n\n[pic]: ./a.png\n",
      1,
      8,
      "expressions",
    ],
    ["expression in a linked image alt", "[![{alt}](./img.png)](./page)\n", 1, 4, "expressions"],
    [
      "default import after a BOM",
      "﻿import Thing from './thing.js'\n\n# Page\n",
      1,
      2,
      "import/export",
    ],
    ["export after a BOM", "﻿export const title = 'x'\n\n# Page\n", 1, 2, "import/export"],
  ])("refuses %s in MDX sources", (_name, source, line, column, kind) => {
    const result = transformMintlify(source, { mdx: true });
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      { line, column, message: expect.stringContaining(`MDX ${kind}`) },
    ]);
    // Markdown sources are not MDX and keep their existing behavior.
    expect(transformMintlify(source).warnings.some((w) => w.message.includes("MDX"))).toBe(false);
  });

  test.each([
    "Escaped \\{braces\\} and `{code}` stay text.\n",
    "```js\nimport x from 'y'\nconst a = {b};\n```\n",
    "Text mentioning import and export.\nimport on a continuation line is prose.\n",
    '{% callout title="x" %}\nBody.\n{% /callout %}\n',
    // Destinations and titles are literal strings in MDX, not expressions.
    '[Link](./page?q={x} "Title {y}")\n',
    '![Alt](https://example.com/a.png?v={x} "Title {y}")\n',
    "[Link `{code}`](./page)\n",
    "![Alt `{code}` and \\{escaped\\}](https://example.com/a.png)\n",
  ])("allows Markdown that only resembles MDX syntax: %j", (source) => {
    expect(transformMintlify(source, { mdx: true }).warnings).toEqual([]);
  });

  // MDX has no indented code, so Markdown would turn this prose into code.
  test.each([
    ["top-level indented prose", "    Plain prose.\n", 1, 1],
    ["indented prose after a BOM", "﻿    Plain prose.\n", 1, 2],
    ["indented prose in a list item", "- Item\n\n      Continued prose.\n", 3, 3],
    ["indented prose in a blockquote", "> Quote\n>\n>     Indented.\n", 3, 3],
    ["an indented component", "    <Note>Example.</Note>\n", 1, 1],
    ["indented prose after a component", "<Note>\n  Body.\n</Note>\n\n    Outside.\n", 5, 1],
  ])("refuses %s in MDX sources", (_name, source, line, column) => {
    const result = transformMintlify(source, { mdx: true });
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      { line, column, message: expect.stringContaining("code block") },
    ]);
    // In Markdown an indented block really is code.
    expect(transformMintlify(source).warnings.some((w) => w.message.includes("code block"))).toBe(
      false,
    );
  });
});
