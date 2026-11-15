import type { Definition, Image, Link } from "mdast";
import type { Handle, Options, State } from "mdast-util-to-markdown";
import { decodeString } from "micromark-util-decode-string";
import { referenceLabel } from "./reference-writer.js";

const entity = /&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/giu;

/** Escape Markdown syntax, without changing the spelling of ordinary URL bytes. */
function destination(url: string, state: State): string {
  const literal = !url || /[()<>\s]/u.test(url);
  const escaped = url
    .replaceAll("\\", "\\\\")
    .replace(entity, (value) => (decodeString(value) === value ? value : `\\${value}`))
    .replace(/[<>\n\r]/gu, (value) =>
      value === "\n" ? "&#xa;" : value === "\r" ? "&#xd;" : `\\${value}`,
    );
  const tableSafe = state.stack.includes("tableCell") ? escaped.replaceAll("|", "\\|") : escaped;
  return literal ? `<${tableSafe}>` : tableSafe;
}

function title(value: string | null | undefined, state: State): string {
  if (value == null) return "";
  const exit = state.enter("titleQuote");
  try {
    // A decoded character reference can contain blank lines. Literal blank
    // source lines terminate resources and definitions instead of their title.
    const escaped = state.safe(value, { before: '"', after: '"' }).replaceAll("\n", "&#xa;");
    return ` "${escaped}"`;
  } finally {
    exit();
  }
}

// CommonMark autolink grammar: a URI autolink, and an email autolink without `mailto:`.
const URI_AUTOLINK = /^[a-z][a-z\d+.-]{1,31}:[^\p{Cc}\s<>]*$/iu;
const EMAIL_AUTOLINK =
  /^[a-z\d_.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/iu;

/**
 * Parser positions show an angle-bracket autolink: its only text child spans
 * the whole link except the two brackets. A resource link `[url](url)` also
 * ends with its destination, so it never matches. Trees without positions, or
 * whose label no longer equals the destination, are written as resources.
 */
function authoredAutolink(node: Link, label: Link["children"][number]): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const labelStart = label.position?.start.offset;
  const labelEnd = label.position?.end.offset;
  return (
    start !== undefined &&
    end !== undefined &&
    labelStart === start + 1 &&
    labelEnd === end - 1 &&
    labelEnd > labelStart
  );
}

/**
 * Keep the author's angle-bracket autolink spelling, which is also the only
 * lossless source form for some literal URLs.
 */
function autolink(node: Link, state: State): string | undefined {
  if (node.title != null || node.children.length !== 1 || node.children[0].type !== "text") return;
  const label = node.children[0].value;
  if (state.stack.includes("tableCell") && label.includes("|")) return;
  if (label === node.url && URI_AUTOLINK.test(node.url)) {
    if (decodeString(node.url) !== node.url || authoredAutolink(node, node.children[0]))
      return `<${node.url}>`;
    return;
  }
  if (
    node.url === `mailto:${label}` &&
    EMAIL_AUTOLINK.test(label) &&
    authoredAutolink(node, node.children[0])
  )
    return `<${label}>`;
}

export function resourceWriterExtension(): NonNullable<Options["extensions"]>[number] {
  const link: Handle = (untyped, _parent, state, info) => {
    const node = untyped as Link;
    const literal = autolink(node, state);
    if (literal !== undefined) return literal;
    const exit = state.enter("link");
    const labelExit = state.enter("label");
    const tracker = state.createTracker(info);
    let result = tracker.move("[");
    result += tracker.move(
      state.containerPhrasing(node, { before: result, after: "](", ...tracker.current() }),
    );
    labelExit();
    result += `](${destination(node.url, state)}${title(node.title, state)})`;
    exit();
    return result;
  };
  const image: Handle = (untyped, _parent, state, info) => {
    const node = untyped as Image;
    const exit = state.enter("image");
    const labelExit = state.enter("label");
    const alt = state
      .safe(node.alt ?? "", { ...info, before: "![", after: "]" })
      .replaceAll("\n", "&#xa;");
    labelExit();
    const result = `![${alt}](${destination(node.url, state)}${title(node.title, state)})`;
    exit();
    return result;
  };
  const definition: Handle = (untyped, _parent, state) => {
    const node = untyped as Definition;
    const exit = state.enter("definition");
    const label = referenceLabel(node);
    const result = `[${label}]: ${destination(node.url, state)}${title(node.title, state)}`;
    exit();
    return result;
  };
  Object.assign(link, {
    peek: (node: Link, _parent: unknown, state: State) =>
      autolink(node, state) === undefined ? "[" : "<",
  });
  Object.assign(image, { peek: () => "!" });
  return { handlers: { link, image, definition } };
}
