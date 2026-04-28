import { describe, expect, test } from "vite-plus/test";
import { transformMintlify } from "./mintlify";

describe("transformMintlify", () => {
  test("converts <Note> to a callout with type", () => {
    const { content } = transformMintlify("<Note>Heads up</Note>\n");
    expect(content).toBe('{% callout type="note" %}Heads up{% /callout %}\n');
  });

  test("converts each callout variant to the right type", () => {
    const variants = ["Note", "Tip", "Info", "Warning", "Check", "Danger"];
    for (const v of variants) {
      const { content } = transformMintlify(`<${v}>x</${v}>`);
      expect(content).toBe(`{% callout type="${v.toLowerCase()}" %}x{% /callout %}`);
    }
  });

  test("converts <Frame> with attributes", () => {
    const { content } = transformMintlify('<Frame caption="A hero">![alt](./img.png)</Frame>');
    expect(content).toBe('{% frame caption="A hero" %}![alt](./img.png){% /frame %}');
  });

  test("converts self-closing tags", () => {
    const { content } = transformMintlify('<Icon icon="bun" />');
    expect(content).toBe('{% icon icon="bun" /%}');
  });

  test("converts known passthrough tags by mechanical rename", () => {
    const { content } = transformMintlify(
      '<Tabs>\n<Tab title="JS">code</Tab>\n<Tab title="TS">code</Tab>\n</Tabs>',
    );
    expect(content).toBe(
      '{% tabs %}\n{% tab title="JS" %}code{% /tab %}\n{% tab title="TS" %}code{% /tab %}\n{% /tabs %}',
    );
  });

  test("preserves single-quoted attribute values", () => {
    const { content } = transformMintlify("<Frame caption='hi'>x</Frame>");
    expect(content).toBe('{% frame caption="hi" %}x{% /frame %}');
  });

  test("warns and drops JSX expression attributes", () => {
    const { content, warnings } = transformMintlify('<Card title="x" icon={Icon} />');
    expect(content).toBe('{% card title="x" /%}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("JSX expression");
    expect(warnings[0].message).toContain("{Icon}");
  });

  test("leaves unknown tags alone", () => {
    const source = "<div>not mine</div> <CustomThing>also not mine</CustomThing>";
    const { content, changed } = transformMintlify(source);
    expect(content).toBe(source);
    expect(changed).toBe(false);
  });

  test("leaves lowercase HTML tags alone", () => {
    const source = "<img src='./x.png' />\n<a href='/foo'>link</a>";
    const { content, changed } = transformMintlify(source);
    expect(content).toBe(source);
    expect(changed).toBe(false);
  });

  test("leaves tags inside fenced code blocks alone", () => {
    const source = "```mdx\n<Note>example</Note>\n```\n";
    const { content, changed } = transformMintlify(source);
    expect(content).toBe(source);
    expect(changed).toBe(false);
  });

  test("leaves tags inside inline code alone", () => {
    const source = "Use the `<Note>` component.\n";
    const { content, changed } = transformMintlify(source);
    expect(content).toBe(source);
    expect(changed).toBe(false);
  });

  test("preserves attribute values verbatim (escapes carry through)", () => {
    const { content } = transformMintlify('<Frame caption="say \\"hi\\"">x</Frame>');
    expect(content).toBe('{% frame caption="say \\"hi\\"" %}x{% /frame %}');
  });

  test("converts nested known tags", () => {
    const source = "<Steps>\n  <Step title='one'>do this</Step>\n</Steps>";
    const { content } = transformMintlify(source);
    expect(content).toBe('{% steps %}\n  {% step title="one" %}do this{% /step %}\n{% /steps %}');
  });

  test("escapes inner double quotes when re-quoting single-quoted attributes", () => {
    const { content } = transformMintlify(`<Frame caption='say "hi"'>x</Frame>`);
    expect(content).toBe('{% frame caption="say \\"hi\\"" %}x{% /frame %}');
  });

  test("does not mistake > inside a quoted attribute for the tag end", () => {
    const { content } = transformMintlify('<Frame caption="x>y">body</Frame>');
    expect(content).toBe('{% frame caption="x>y" %}body{% /frame %}');
  });

  test("does not mistake > inside a JSX expression for the tag end", () => {
    const { content, warnings } = transformMintlify("<Card icon={a > b} />");
    expect(content).toBe("{% card /%}");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("{a > b}");
  });

  test("warning column points at the offending attribute, not the tag start", () => {
    const source = '<Card title="x" icon={Icon} />';
    const { warnings } = transformMintlify(source);
    expect(warnings).toHaveLength(1);
    // "icon={Icon}" starts at column 17 (1-indexed); the < is at column 1
    expect(warnings[0].column).toBe(17);
  });

  test("leaves files with no Mintlify components untouched", () => {
    const source = "# Hello\n\nJust regular markdown.\n";
    const { content, changed } = transformMintlify(source);
    expect(content).toBe(source);
    expect(changed).toBe(false);
  });
});
