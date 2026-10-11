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
    expect(output.slice(frontmatter.length)).toContain('{% callout variant="info" %}\nBody.');
    expect(output).toContain("{% /callout %}");
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
