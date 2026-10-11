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

  test.each(["\n", "\r\n", "\r"])("preserves frontmatter bytes with %j line endings", (eol) => {
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

  test.each([
    "<Note>\nUse a single ` as a delimiter.\n</Note>\n`example`\n",
    '<Tabs>\n<Tab title="CLI">\nUse a single ` as a delimiter.\n</Tab>\n</Tabs>\n`example`\n',
    "| A | B |\n| - | - |\n| ` | x |\n| y | `<Note>literal</Note>` |\n\n<Note>Body.</Note>\n",
    '[Docs](./intro "`<Note>literal</Note>`")\n\n<Note>Body.</Note>\n',
    "{% callout %}\n` unmatched\n{% /callout %}\n`<Note>literal</Note>`\n\n<Note>Body.</Note>\n",
  ])("preserves existing body migration behavior after a header: %s", (body) => {
    const bodyOutput = converted(body);
    const header = '\uFEFF---\r\ntitle: "<Note>Metadata</Note>"\r\n---\r\n';
    const output = converted(header + body);
    expect(output).toBe(header + bodyOutput);
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

  test("warns on unsupported raw JSX even without a recognized convertible tag", () => {
    const source = '<CustomThing title="x" />';
    const result = transformMintlify(source);
    expect(result).toMatchObject({ content: source, changed: false });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
