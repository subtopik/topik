export const mathNamespace = "http://www.w3.org/1998/Math/MathML";
export const maximumMathDimension = 4096;

// KaTeX's passive presentation MathML only. In particular, mglyph, links,
// annotation-xml, arbitrary CSS and namespace changes never reach the page.
const elements = new Set([
  "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "mspace",
  "msub", "msup", "msubsup", "mfrac", "msqrt", "mroot", "mover", "munder",
  "munderover", "mtable", "mtr", "mtd", "mlabeledtr", "menclose", "mstyle",
  "mpadded", "mphantom",
]);
const booleans = new Set([
  "accent", "accentunder", "displaystyle", "fence", "largeop", "movablelimits",
  "separator", "stretchy",
]);
const lengths = new Set([
  "width", "height", "depth", "lspace", "rspace", "voffset", "minsize", "maxsize",
  "mathsize", "linethickness", "rowspacing", "columnspacing",
]);
const keywords: Record<string, RegExp> = {
  display: /^(block|inline)$/,
  scriptlevel: /^[0-2]$/,
  mathvariant: /^(normal|bold|italic|bold-italic|double-struck|bold-fraktur|script|bold-script|fraktur|sans-serif|bold-sans-serif|sans-serif-italic|sans-serif-bold-italic|monospace|initial|tailed|looped|stretched)$/,
  columnalign: /^(left|center|right)( (left|center|right))*$/,
  rowalign: /^(top|bottom|center|baseline|axis)( (top|bottom|center|baseline|axis))*$/,
  columnlines: /^(none|solid|dashed)( (none|solid|dashed))*$/,
  rowlines: /^(none|solid|dashed)( (none|solid|dashed))*$/,
  notation: /^(box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|phasorangle|longdiv|actuarial|radical)( (box|roundedbox|circle|left|right|top|bottom|updiagonalstrike|downdiagonalstrike|verticalstrike|horizontalstrike|phasorangle|longdiv|actuarial|radical))*$/,
  linebreak: /^newline$/,
};

export function validateDiagramMath(math: Element): void {
  if (math.localName !== "math") throw new Error("Invalid diagram math root");
  const nodes = [math, ...math.querySelectorAll("*")];
  if (nodes.length > 2048) throw new Error("Diagram math is too complex");
  for (const element of nodes) {
    if ([...element.childNodes].some((node) => node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE)) {
      throw new Error("Unsupported diagram math node");
    }
    if (element.namespaceURI !== mathNamespace || !elements.has(element.localName)) {
      throw new Error("Unsupported diagram math element");
    }
    let depth = 0;
    for (let parent = element.parentElement; parent && parent !== math.parentElement; parent = parent.parentElement) {
      if (++depth > 64) throw new Error("Diagram math is too deep");
    }
    if (element.localName === "annotation" && element.children.length) {
      throw new Error("Unsupported diagram math annotation");
    }
    for (const { name, value } of element.attributes) {
      let valid = false;
      if (name === "xmlns") valid = element === math && value === mathNamespace;
      else if (name === "encoding") valid = element.localName === "annotation" && value === "application/x-tex";
      else if (booleans.has(name)) valid = /^(true|false)$/.test(value);
      else if (lengths.has(name)) {
        valid = value.length <= 256 && value.split(" ").every((length) => {
          const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(em|ex|px|pt|%)?$/.exec(length);
          return match !== null && Math.abs(Number(match[1])) <= 1000;
        });
      } else if (name === "mathcolor" || name === "mathbackground") {
        valid = /^(#[\da-f]{3,8}|[a-z]+)$/i.test(value) && value.length <= 32;
      } else valid = keywords[name]?.test(value) ?? false;
      if (!valid) throw new Error(`Unsupported diagram math attribute: ${name}`);
    }
  }
}

export function parseDiagramMath(markup: string): Element {
  const document = new DOMParser().parseFromString(markup, "application/xml");
  const wrapper = document.documentElement;
  const math = wrapper.firstElementChild;
  if (
    document.doctype || document.querySelector("parsererror") || wrapper.localName !== "span" ||
    wrapper.namespaceURI !== null || wrapper.attributes.length !== 1 ||
    wrapper.getAttribute("class") !== "katex" || wrapper.childNodes.length !== 1 || !math
  ) throw new Error("Invalid KaTeX MathML");
  validateDiagramMath(math);
  return math;
}
