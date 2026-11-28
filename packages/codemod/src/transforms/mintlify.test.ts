import { parseTopikContent, validateTopikContent } from "@topik/content";
import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

function converted(source: string): string {
  const result = transformMintlify(source);
  expect(result.warnings).toEqual([]);
  expect(result.changed).toBe(true);
  expect(validateTopikContent(result.content)).toMatchObject({ ok: true, diagnostics: [] });
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
      '<CardGroup cols="2">',
      '<Card title="First" href="/first" />',
      "</CardGroup>",
      '<Tabs><Tab title="CLI">Use it.</Tab></Tabs>',
      '<Steps><Step title="Install">Run it.</Step></Steps>',
      '<Accordion title="More">Details.</Accordion>',
    ].join("\n");
    const output = converted(source);
    expect(output).toContain(
      '{% columns count=2 %}\n{% card title="First" href="/first" /%}\n{% /columns %}',
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
    "<CodeGroup>\n```js\nhello\n```\n</CodeGroup>",
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
        expect(validateTopikContent(original).ok).toBe(true);
        expect(transformMintlify(original)).toEqual({
          content: original,
          warnings: [],
          changed: false,
        });
        // Definition fixtures include their terminating newline; JSX directly
        // follows inline resources to exercise the protected range boundary,
        // where it is inline JSX: it is found right after the resource and refused.
        const adjacent = `${prefix}<Note>Real.</Note>\n`;
        if (prefix.endsWith("\n")) {
          expect(converted(adjacent)).toBe(
            `${prefix}{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
          );
          continue;
        }
        const lastLine = prefix.split(eol).at(-1)!;
        expect(transformMintlify(adjacent)).toEqual({
          content: adjacent,
          changed: false,
          warnings: [
            {
              line: prefix.split(eol).length,
              column: lastLine.length + 1,
              message: expect.stringContaining("paragraph with other text"),
            },
          ],
        });
        expect(converted(`${prefix}${eol}${eol}<Note>Real.</Note>\n`)).toBe(
          `${prefix}${eol}${eol}{% callout variant="info" %}\nReal.\n{% /callout %}\n`,
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
      // The tag is found (not hidden in code) and refused as inline paragraph JSX.
      const source = `${prefix}<Note>Real.</Note>\n`;
      expect(transformMintlify(source)).toEqual({
        content: source,
        changed: false,
        warnings: [
          {
            line: 1,
            column: prefix.length + 1,
            message: expect.stringContaining("paragraph with other text"),
          },
        ],
      });
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

  test.each([2, 4])("recognizes tags after %s backslashes", (count) => {
    const slashes = "\\".repeat(count);
    // Escaped backslashes are paragraph text, so the tag is inline and refused.
    const source = `${slashes}<Note>Actual.</Note>\n`;
    expect(transformMintlify(source)).toEqual({
      content: source,
      changed: false,
      warnings: [
        {
          line: 1,
          column: count + 1,
          message: expect.stringContaining("paragraph with other text"),
        },
      ],
    });
    const output = converted(`${slashes}\n\n<Note>Actual.</Note>\n`);
    expect(output).toBe(`${slashes}\n\n{% callout variant="info" %}\nActual.\n{% /callout %}\n`);
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

describe("inline positions", () => {
  test.each([
    ["a table cell", "| a | b |\n|---|---|\n| <Note>x</Note> | y |\n", 3, 3, "Markdown table"],
    ["an ATX heading", "# Title <Tip>t</Tip>\n", 1, 9, "Markdown heading"],
    ["a setext heading", "Title <Tip>t</Tip>\n===\n", 1, 7, "Markdown heading"],
    [
      "the middle of a paragraph",
      "Text with <Tip>inline</Tip> in the middle.\n",
      1,
      11,
      "paragraph with other text",
    ],
    ["text after a component", "<Tip>inline</Tip> trailing.\n", 1, 1, "paragraph with other text"],
    ["a self-closing card in text", 'See <Card title="A" /> here.\n', 1, 5, "paragraph"],
    [
      "a nested component among body text",
      "<Note>\nSee <Tip>this</Tip> now.\n</Note>\n",
      2,
      5,
      "paragraph with other text",
    ],
  ])("keeps JSX inside %s", (_name, source, line, column, context) => {
    for (const mdx of [false, true]) {
      for (const eol of ["\n", "\r\n", "\r"]) {
        const original = source.replaceAll("\n", eol);
        expect(transformMintlify(original, { mdx })).toEqual({
          content: original,
          changed: false,
          warnings: [{ line, column, message: expect.stringContaining(context) }],
        });
      }
    }
  });

  test("still converts paragraphs that contain only components", () => {
    expect(converted('<Note>One.</Note><Card title="A" />\n<Tip>Two\nlines.</Tip>\n')).toBe(
      '{% callout variant="info" %}\nOne.\n{% /callout %}\n{% card title="A" /%}\n' +
        '{% callout variant="tip" %}\nTwo\nlines.\n{% /callout %}\n',
    );
  });
});

describe("multi-line opening tags", () => {
  test.each(["  ", "    ", "\t"])("dedents a body indented by %j under the tag", (unit) => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const source = [
        "<Card",
        '  title="C"',
        '  href="/sub/b.mdx"',
        ">",
        `${unit}Body multi`,
        `${unit}continued.`,
        "</Card>",
        "",
      ].join(eol);
      const result = transformMintlify(source, { mdx: true });
      expect(result).toEqual({
        content: [
          '{% card title="C" href="/sub/b.mdx" %}',
          "Body multi",
          "continued.",
          "{% /card %}",
          "",
        ].join(eol),
        warnings: [],
        changed: true,
      });
    }
  });

  test("dedents nested bodies under multi-line opening tags", () => {
    const source = [
      "<Steps>",
      "  <Step",
      '    title="A"',
      "  >",
      "    Body.",
      "  </Step>",
      "</Steps>",
      "",
    ].join("\n");
    expect(converted(source)).toBe(
      '{% steps %}\n{% step title="A" %}\nBody.\n{% /step %}\n{% /steps %}\n',
    );
  });
});

describe("Mintlify code groups", () => {
  test("wraps each titled fence in a code tab", () => {
    const source = [
      "<CodeGroup>",
      "```bash npm",
      "npm i @topik/cli",
      "```",
      "",
      "~~~~ts Hello World.ts",
      "const x = 1;",
      "~~~~",
      "</CodeGroup>",
      "",
    ].join("\n");
    const output = converted(source);
    expect(output).toBe(
      [
        "{% codeGroup %}",
        '{% codeTab title="npm" %}',
        "```bash",
        "npm i @topik/cli",
        "```",
        "{% /codeTab %}",
        '{% codeTab title="Hello World.ts" %}',
        "~~~~ts",
        "const x = 1;",
        "~~~~",
        "{% /codeTab %}",
        "{% /codeGroup %}",
        "",
      ].join("\n"),
    );
    expect(parseTopikContent(output).children[0]).toMatchObject({
      type: "topikComponent",
      name: "codeGroup",
      children: [
        {
          name: "codeTab",
          props: { title: "npm" },
          children: [{ type: "code", lang: "bash", value: "npm i @topik/cli" }],
        },
        {
          name: "codeTab",
          props: { title: "Hello World.ts" },
          children: [{ type: "code", lang: "ts", value: "const x = 1;" }],
        },
      ],
    });
    expect(transformMintlify(output)).toEqual({ content: output, warnings: [], changed: false });
  });

  test("dedents fences and keeps line endings inside tabs", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const source = [
        "<Tabs>",
        '  <Tab title="Install">',
        "    <CodeGroup>",
        "      ```bash npm",
        "      npm i x",
        "      ```",
        "    </CodeGroup>",
        "  </Tab>",
        "</Tabs>",
        "",
      ].join(eol);
      expect(transformMintlify(source, { mdx: true })).toEqual({
        content: [
          "{% tabs %}",
          '{% tab title="Install" %}',
          "{% codeGroup %}",
          '{% codeTab title="npm" %}',
          "```bash",
          "npm i x",
          "```",
          "{% /codeTab %}",
          "{% /codeGroup %}",
          "{% /tab %}",
          "{% /tabs %}",
          "",
        ].join(eol),
        warnings: [],
        changed: true,
      });
    }
  });

  test.each([
    ["no title", "```js\nx\n```", "has no title"],
    ["no language", "```\nx\n```", "has no title"],
    ["highlight options", "```js app.js {1-3}\nx\n```", "options"],
    ["attribute options", '```js title="app.js"\nx\n```', "options"],
    ["display flags", "```js app.js wrap\nx\n```", "options"],
  ])("keeps a code group whose fence has %s", (_name, fence, message) => {
    const source = `<CodeGroup>\n${fence}\n</CodeGroup>\n`;
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      { line: 2, column: 1, message: expect.stringContaining(message) },
    ]);
  });

  test("keeps a code group with prose beside its fences", () => {
    const source = "<CodeGroup>\nIntro.\n\n```js a.js\nx\n```\n</CodeGroup>\n";
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining("not valid Topik content") }),
    ]);
  });
});

describe("Mintlify grids", () => {
  test("converts Columns with cards and arbitrary Column content", () => {
    const output = converted(
      [
        "<Columns cols={3}>",
        '<Card title="A" href="/a" />',
        "<Column>",
        "Text beside the card.",
        "</Column>",
        "</Columns>",
        "",
      ].join("\n"),
    );
    expect(output).toBe(
      [
        "{% columns count=3 %}",
        '{% card title="A" href="/a" /%}',
        "{% column %}",
        "Text beside the card.",
        "{% /column %}",
        "{% /columns %}",
        "",
      ].join("\n"),
    );
    expect(parseTopikContent(output).children).toMatchObject([
      {
        name: "columns",
        props: { count: 3 },
        children: [{ name: "card" }, { name: "column" }],
      },
    ]);
  });

  test("wraps other content between cells in a column, with a note", () => {
    const result = transformMintlify(
      [
        "<Columns cols={2}>",
        "  Intro text.",
        "",
        "  <Note>Careful.</Note>",
        '  <Card title="A" />',
        "  More.",
        "</Columns>",
        "",
      ].join("\n"),
    );
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      [
        "{% columns count=2 %}",
        "{% column %}",
        "Intro text.",
        "",
        '{% callout variant="info" %}',
        "Careful.",
        "{% /callout %}",
        "{% /column %}",
        '{% card title="A" /%}',
        "{% column %}",
        "More.",
        "{% /column %}",
        "{% /columns %}",
        "",
      ].join("\n"),
    );
    expect(validateTopikContent(result.content)).toMatchObject({ ok: true });
    // One note per group, at the first wrapped content.
    expect(result.warnings).toEqual([
      expect.objectContaining({
        line: 2,
        message: expect.stringContaining("wrapped in a column"),
      }),
    ]);
  });

  test("wraps text in a CardGroup the same way", () => {
    const result = transformMintlify('<CardGroup>\nText\n<Card title="A" />\n</CardGroup>\n');
    expect(result).toMatchObject({
      changed: true,
      content:
        '{% columns %}\n{% column %}\nText\n{% /column %}\n{% card title="A" /%}\n{% /columns %}\n',
    });
  });

  test("a CardGroup without cols keeps Mintlify's two columns", () => {
    expect(converted('<CardGroup>\n<Card title="A" />\n</CardGroup>\n')).toBe(
      '{% columns %}\n{% card title="A" /%}\n{% /columns %}\n',
    );
  });
});

describe("Mintlify attribute forms", () => {
  test("maps literal JSX expressions and renamed attributes", () => {
    const output = converted(
      [
        "<CardGroup cols={2}>",
        '<Card title="A" icon="star" />',
        "</CardGroup>",
        '<Accordion title="Bare" defaultOpen>Body.</Accordion>',
        '<Accordion title="Literal" defaultOpen={false}>Body.</Accordion>',
        '<Accordion title="Topik" open={true}>Body.</Accordion>',
        "",
      ].join("\n"),
    );
    expect(output).toBe(
      [
        "{% columns count=2 %}",
        '{% card title="A" icon="star" /%}',
        "{% /columns %}",
        '{% accordion title="Bare" open=true %}',
        "Body.",
        "{% /accordion %}",
        '{% accordion title="Literal" open=false %}',
        "Body.",
        "{% /accordion %}",
        '{% accordion title="Topik" open=true %}',
        "Body.",
        "{% /accordion %}",
        "",
      ].join("\n"),
    );
    expect(parseTopikContent(output).children).toMatchObject([
      { name: "columns", props: { count: 2 } },
      { name: "accordion", props: { open: true } },
      { name: "accordion", props: { open: false } },
      { name: "accordion", props: { open: true } },
    ]);
  });

  test.each([
    [
      '<CardGroup cols={columns}>\n<Card title="A" />\n</CardGroup>\n',
      "Dynamic JSX attribute cols",
    ],
    [
      '<CardGroup cols={true}>\n<Card title="A" />\n</CardGroup>\n',
      "cols requires a finite number",
    ],
    ['<Accordion title="A" defaultOpen={1}>B</Accordion>\n', "defaultOpen requires a boolean"],
    ["<Accordion title={2}>B</Accordion>\n", "title requires a string"],
    ['<Card title="A" featured />\n', "featured is unsupported"],
    ['<Card title="A" cols={2} />\n', "cols is unsupported"],
    ['<Step title="A" icon={Icon}>B</Step>\n', "Dynamic JSX attribute icon"],
  ])("keeps unsupported attribute forms: %j", (source, message) => {
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining(message) }),
    ]);
  });

  test("drops icons Topik steps, tabs and accordions cannot show, with a warning", () => {
    const source = [
      '<Steps><Step title="A" icon="rocket">One.</Step></Steps>',
      '<Tabs><Tab title="B" icon="code">Two.</Tab></Tabs>',
      '<Accordion title="C" icon="info">Three.</Accordion>',
      "",
    ].join("\n");
    const result = transformMintlify(source, { mdx: true });
    expect(result.changed).toBe(true);
    expect(result.content).toBe(
      [
        "{% steps %}",
        '{% step title="A" %}',
        "One.",
        "{% /step %}",
        "{% /steps %}",
        "{% tabs %}",
        '{% tab title="B" %}',
        "Two.",
        "{% /tab %}",
        "{% /tabs %}",
        '{% accordion title="C" %}',
        "Three.",
        "{% /accordion %}",
        "",
      ].join("\n"),
    );
    expect(result.warnings).toEqual([
      { line: 1, column: 24, message: expect.stringContaining("icon on <Step>") },
      { line: 2, column: 22, message: expect.stringContaining("icon on <Tab>") },
      { line: 3, column: 22, message: expect.stringContaining("icon on <Accordion>") },
    ]);
    // A refused file reports only its refusals, not icons it did not drop.
    const kept = transformMintlify(`${source}<Icon icon="x" />\n`);
    expect(kept.changed).toBe(false);
    expect(kept.warnings).toEqual([
      expect.objectContaining({ message: expect.stringContaining("no equivalent") }),
    ]);
  });
});

describe("tag nesting", () => {
  test.each([
    ["a mismatched closing tag", "<Note>\nbody\n</Tip>\n", 3, "</Tip> does not match <Note>"],
    [
      "crossed nesting",
      "<Tabs>\n<Tab title='A'>\nx\n</Tabs>\n</Tab>\n",
      4,
      "</Tabs> does not match <Tab>",
    ],
    ["an orphan closing tag", "body\n\n</Note>\n", 3, "</Note> has no matching opening tag"],
    ["an unclosed tag", "<Note>\nbody\n", 1, "<Note> is never closed"],
  ])("keeps %s", (_name, source, line, message) => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const original = source.replaceAll("\n", eol);
      const result = transformMintlify(original);
      expect(result).toMatchObject({ content: original, changed: false });
      expect(result.warnings).toEqual([
        { line, column: 1, message: expect.stringContaining(message) },
      ]);
    }
  });

  test.each([
    ["member-expression tags", "<Note.Sub>\nbody\n</Note.Sub>\n"],
    ["underscored component tags", "<Info_2>\nbody\n</Info_2>\n"],
  ])("does not misparse %s as Mintlify components", (_name, source) => {
    expect(transformMintlify(source)).toEqual({ content: source, warnings: [], changed: false });
  });

  test("does not misparse hyphenated component tags as Mintlify components", () => {
    const source = '<Card-custom title="A" />\n';
    const result = transformMintlify(source);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(source);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("Source is not valid Topik content"),
      }),
    ]);
    expect(result.warnings[0]?.message).not.toContain("Unsupported attributes");
  });

  test("ignores non-Mintlify tags with shared prefixes when converting valid tags", () => {
    const source = "<Note>\nbody\n</Note>\n\n<Note.Sub>\nextra\n</Note.Sub>\n";
    expect(transformMintlify(source)).toEqual({
      content:
        '{% callout variant="info" %}\nbody\n{% /callout %}\n\n<Note.Sub>\nextra\n</Note.Sub>\n',
      warnings: [],
      changed: true,
    });
  });
});

describe("CR-only line endings", () => {
  test("keeps lone CR terminators and dedents bodies", () => {
    expect(converted("# T\r\r<Note>\r  x\r</Note>\r")).toBe(
      '# T\r\r{% callout variant="info" %}\rx\r{% /callout %}\r',
    );
  });

  test("splits same-line bodies with CR and preserves frontmatter bytes", () => {
    const header = '﻿---\rtitle: "<Note>x</Note>"\r---\r\r';
    const output = converted(`${header}<Tabs><Tab title="A">Body</Tab></Tabs>`);
    expect(output).toBe(
      `${header}{% tabs %}\r{% tab title="A" %}\rBody\r{% /tab %}\r{% /tabs %}\r`,
    );
    expect(transformMintlify(output)).toEqual({ content: output, warnings: [], changed: false });
  });

  test.each(["\n", "\r\n", "\r"])("keeps a BOM directly before a tag with %j", (eol) => {
    expect(converted(`﻿<Note>${eol}  x${eol}</Note>${eol}`)).toBe(
      `﻿{% callout variant="info" %}${eol}x${eol}{% /callout %}${eol}`,
    );
  });

  test("reports warnings at CR-separated lines", () => {
    expect(transformMintlify("# T\r\r<Card title={x} />\r").warnings).toEqual([
      expect.objectContaining({ line: 3, column: 7, message: expect.stringContaining("Dynamic") }),
    ]);
  });
});
