// Pele escapes author text and filters styles. Keep a second, fail-closed boundary
// before inserting its SVG: diagrams cannot create active content or fetch URLs.
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
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("Invalid diagram SVG");
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.namespaceURI !== "http://www.w3.org/2000/svg" || !elements.has(element.localName)) {
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
