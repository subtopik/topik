// Pele escapes author text and filters styles. Keep a second, fail-closed boundary
// before inserting its SVG: diagrams cannot create active content or fetch URLs.
import { maximumMathDimension, validateDiagramMath } from "./diagram-mathml";

const svgNamespace = "http://www.w3.org/2000/svg";
const htmlNamespace = "http://www.w3.org/1999/xhtml";
const elements = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "marker",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
]);
const attributes = new Set([
  "xmlns",
  "xml:space",
  "id",
  "class",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "style",
  "role",
  "aria-roledescription",
  "aria-labelledby",
  "aria-describedby",
  "aria-label",
  "aria-hidden",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-decoration",
  "dx",
  "dy",
  "rotate",
  "textLength",
  "lengthAdjust",
  "marker-start",
  "marker-mid",
  "marker-end",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "clip-path",
  "clipPathUnits",
  "mask",
  "maskUnits",
  "maskContentUnits",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stop-color",
  "stop-opacity",
  "href",
  "preserveAspectRatio",
  "vector-effect",
  "paint-order",
  "overflow",
]);

export function safeDiagramSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.doctype || document.querySelector("parsererror")) {
    throw new Error("Invalid diagram SVG");
  }
  const mathNodes = new Set<Element>();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    // XML processing instructions/CDATA can change meaning when this string
    // is later parsed as HTML. Pele needs only elements and ordinary text.
    if (
      [...element.childNodes].some(
        (node) => node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE,
      )
    ) {
      throw new Error("Unsupported diagram node");
    }
    if (mathNodes.has(element)) continue;
    if (element.namespaceURI === svgNamespace && element.localName === "foreignObject") {
      validateMathContainer(element);
      for (const child of element.querySelectorAll("*")) mathNodes.add(child);
      continue;
    }
    if (element.namespaceURI !== svgNamespace || !elements.has(element.localName)) {
      throw new Error("Unsupported diagram element");
    }
    for (const attribute of element.attributes) {
      const { name, value } = attribute;
      if (!attributes.has(name) && !/^data-[\w-]+$/.test(name)) {
        throw new Error(`Unsupported diagram attribute: ${name}`);
      }
      if (name === "href" && !/^#[\w-]+$/.test(value)) {
        throw new Error("External diagram reference");
      }
      if (
        name === "style" ||
        [
          "fill",
          "stroke",
          "clip-path",
          "mask",
          "marker-start",
          "marker-mid",
          "marker-end",
        ].includes(name)
      ) {
        // Only local fragment paints are permitted. CSS escapes/comments cannot
        // disguise a URL, and stylesheets/animation are never accepted.
        const local = value.replace(/url\(#[\w-]+\)/g, "");
        // eslint-disable-next-line no-control-regex
        if (/url\s*\(|image|expression|javascript|@|\\|\/\*|[<>\u0000-\u001f]/i.test(local)) {
          throw new Error("Unsafe diagram style");
        }
      }
    }
  }
  return new XMLSerializer().serializeToString(root);
}

// Pele 1.8's MathML bridge is the only permitted foreignObject. Accept its
// exact passive wrapper, never general HTML or mixed SVG/HTML descendants.
function validateMathContainer(container: Element): void {
  const allowed = new Set(["class", "x", "y", "width", "height", "overflow", "color", "opacity"]);
  for (const { name, value } of container.attributes) {
    if (!allowed.has(name)) throw new Error("Unsupported diagram math container attribute");
    if (["x", "y", "width", "height", "opacity"].includes(name)) {
      if (!/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
        throw new Error("Invalid diagram math container size");
      }
      const number = Number(value);
      if (
        ((name === "width" || name === "height") && (number <= 0 || number > maximumMathDimension)) ||
        ((name === "x" || name === "y") && Math.abs(number) > 10_000_000) ||
        (name === "opacity" && (number < 0 || number > 1))
      )
        throw new Error("Invalid diagram math container size");
    }
    if (name === "color" && !/^(#[\da-f]{3,8}|[a-z]+|var\(--[\w-]+\))$/i.test(value)) {
      throw new Error("Unsupported diagram math color");
    }
  }
  const wrapper = container.firstElementChild;
  const math = wrapper?.firstElementChild;
  if (
    container.getAttribute("class") !== "pele-math" ||
    container.getAttribute("overflow") !== "visible" ||
    !["x", "y", "width", "height"].every((name) => container.hasAttribute(name)) ||
    container.childNodes.length !== 1 ||
    !wrapper ||
    wrapper.localName !== "div" ||
    wrapper.namespaceURI !== htmlNamespace ||
    wrapper.attributes.length !== 2 ||
    wrapper.getAttribute("xmlns") !== htmlNamespace ||
    !/^display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:(?:\d+(?:\.\d+)?)px;line-height:normal;white-space:nowrap$/.test(
      wrapper.getAttribute("style") ?? "",
    ) ||
    wrapper.childNodes.length !== 1 ||
    !math
  )
    throw new Error("Unsupported diagram math container");
  const fontSize = /font-size:([\d.]+)px/.exec(wrapper.getAttribute("style")!)!;
  if (Number(fontSize[1]) <= 0 || Number(fontSize[1]) > 256) {
    throw new Error("Invalid diagram math font size");
  }
  validateDiagramMath(math);
}
