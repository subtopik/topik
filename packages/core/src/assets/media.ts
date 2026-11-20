const MARKUP_INSPECTION_LIMIT = 64 * 1024;
/** Elements that execute, embed, load, or navigate when bytes are rendered as HTML. */
const ACTIVE_HTML_ELEMENT =
  /<!doctype\s+html\b|<\/?(?:applet|base|body|embed|form|frame|frameset|head|html|iframe|link|meta|object|portal|script|style)(?:\s|>|\/)/iu;
/** An `xmlns` or `xmlns:prefix` declaration whose value contains a character or entity reference. */
const ENCODED_NAMESPACE_DECLARATION = /xmlns[^\s=<>"']*\s*=\s*(?:"[^"<]*&|'[^'<]*&)/u;
export const TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE = "application/x-topik-active-content" as const;

/** Sniff exact bytes conservatively. Unknown safe bytes remain opaque downloads. */
export function sniffPortableMediaType(bytes: Uint8Array): string {
  const has = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (has(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (has(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const isoMediaType = sniffIsoBaseMediaType(bytes);
  if (isoMediaType !== undefined) return isoMediaType;
  if (isBmp(bytes)) return "image/bmp";
  if (isTiff(bytes)) return "image/tiff";
  if (has(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (has(0x50, 0x4b, 0x03, 0x04) || has(0x50, 0x4b, 0x05, 0x06)) return "application/zip";
  if (has(0x1f, 0x8b)) return "application/gzip";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(bytes, 0, 4) === "fLaC") return "audio/flac";
  if (hasId3Header(bytes) || isMpegAudioFrameSequence(bytes)) return "audio/mpeg";
  if (isAdtsFrameSequence(bytes)) return "audio/aac";
  if (ebmlDocType(bytes) === "webm") return "video/webm";
  if (
    has(0x7f, 0x45, 0x4c, 0x46) ||
    isPortableExecutable(bytes) ||
    has(0xfe, 0xed, 0xfa, 0xce) ||
    has(0xce, 0xfa, 0xed, 0xfe) ||
    has(0xfe, 0xed, 0xfa, 0xcf) ||
    has(0xcf, 0xfa, 0xed, 0xfe) ||
    has(0xca, 0xfe, 0xba, 0xbe) ||
    hasInterpreterLine(bytes)
  ) {
    return "application/x-executable";
  }
  if (has(0x00, 0x61, 0x73, 0x6d)) return "application/wasm";
  return sniffPortableMarkupType(bytes) ?? "application/octet-stream";
}

export function isTopikActiveMediaType(mediaType: string): boolean {
  return [
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/x-executable",
    "application/wasm",
    TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE,
  ].includes(mediaType);
}

/** Video slots admit only the formats every current browser plays in a `<video>` element. */
const BROWSER_VIDEO_TYPES = new Set(["video/mp4", "video/webm"]);

export function isInlineMediaCompatible(mediaType: string, role: string): boolean {
  if (role === "video") return BROWSER_VIDEO_TYPES.has(mediaType);
  return role.startsWith("image")
    ? mediaType.startsWith("image/")
    : /^(?:image|audio|video)\//u.test(mediaType);
}

function sniffPortableMarkupType(bytes: Uint8Array): string | undefined {
  const boundary = Math.min(bytes.byteLength, MARKUP_INSPECTION_LIMIT);
  const completionBytes = trailingUtf8Completion(bytes.slice(0, boundary));
  if (completionBytes > bytes.byteLength - boundary) {
    return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
  }
  const inspectedEnd = boundary + completionBytes;

  if (completionBytes > 0) {
    const sequenceStart = trailingUtf8SequenceStart(bytes.slice(0, boundary));
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(sequenceStart, inspectedEnd));
    } catch {
      return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
    }
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.slice(0, inspectedEnd))
      .toLowerCase();
  } catch {
    return undefined;
  }

  let cursor = skipMarkupWhitespace(text, 0);
  let consumedPreamble = false;
  let xmlDeclaration = false;
  let otherProcessingInstruction = false;
  while (cursor < text.length) {
    if (text.startsWith("<!--", cursor)) {
      const end = text.indexOf("-->", cursor + 4);
      if (end === -1) return "text/html";
      consumedPreamble = true;
      cursor = skipMarkupWhitespace(text, end + 3);
      continue;
    }
    if (text.startsWith("<?xml", cursor)) {
      const end = text.indexOf("?>", cursor + 5);
      if (end === -1) return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
      // `<?xml ...?>` declares an XML document; `<?xml-stylesheet ...?>` and other
      // processing instructions can transform it, so they keep the strict leading-tag rule.
      if (/^<\?xml(?:\s|\?)/u.test(text.slice(cursor, cursor + 6))) xmlDeclaration = true;
      else otherProcessingInstruction = true;
      consumedPreamble = true;
      cursor = skipMarkupWhitespace(text, end + 2);
      continue;
    }
    break;
  }

  if (cursor === text.length) {
    return bytes.byteLength > inspectedEnd && (cursor > 0 || consumedPreamble)
      ? TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE
      : undefined;
  }

  const markup = text.slice(cursor);
  const truncated = bytes.byteLength > inspectedEnd;
  if (/<!doctype\s+svg\b/u.test(markup) || hasSvgElement(markup, truncated)) {
    return "image/svg+xml";
  }
  // A document that declares itself XML and whose root is neither HTML nor SVG (a plist, a
  // feed, a project file) is data, not a page, unless it names the XHTML or SVG namespace.
  // In XML an element runs as script because of its namespace, whatever its prefix, so a
  // namespace declaration that hides its value behind a character or entity reference is
  // treated as naming one of them.
  const xmlData =
    xmlDeclaration &&
    !otherProcessingInstruction &&
    isNonHtmlXmlRoot(markup) &&
    !ENCODED_NAMESPACE_DECLARATION.test(markup) &&
    !markup.includes("http://www.w3.org/1999/xhtml") &&
    !markup.includes("http://www.w3.org/2000/svg");
  if (
    // Any tag that opens the document (after whitespace, a BOM, comments, or an XML
    // declaration) is HTML, which is stricter than the WHATWG mimesniff HTML patterns. Later
    // in the text, only elements that can run, load, or navigate are active, so prose and code
    // such as `Array<string>` remain plain text.
    (!xmlData && /^<[a-z][a-z0-9:-]*(?:\s|>|\/)/u.test(markup)) ||
    ACTIVE_HTML_ELEMENT.test(markup) ||
    /<script\b/iu.test(markup) ||
    hasActiveAttribute(markup, truncated)
  ) {
    return "text/html";
  }
  if (xmlData && !truncated) return undefined;
  if (markup.startsWith("<") && (consumedPreamble || truncated)) {
    return TOPIK_UNRESOLVED_ACTIVE_CONTENT_TYPE;
  }
  return undefined;
}

/** An attribute that runs script when its tag is parsed: an event handler or a `javascript:` URL. */
const EVENT_HANDLER_ATTRIBUTE = /[\s"'/]on[a-z][a-z0-9_-]*\s*=/u;
const JAVASCRIPT_URL_ATTRIBUTE = /(?:href|src)\s*=\s*["']?\s*javascript:/u;

/**
 * Scan each start tag (`<` followed by a letter, up to the next `>`) once for active attributes,
 * so the check is linear in the inspected text and only real attributes count: `x < y then on =`
 * and `i<n;el.onclick=` are not tags. A tag left open at the end of complete text is discarded
 * by HTML parsers; in truncated text it may close later and is inspected to the end.
 */
function hasActiveAttribute(markup: string, truncated: boolean): boolean {
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start === -1) return false;
    if (!isAsciiLetter(markup.charCodeAt(start + 1))) {
      cursor = start + 1;
      continue;
    }
    let end = markup.indexOf(">", start);
    if (end === -1) {
      if (!truncated) return false;
      end = markup.length;
    }
    // A later `<` before this `>` starts a suffix of the same span, so one test covers both.
    const tag = markup.slice(start, end);
    if (EVENT_HANDLER_ATTRIBUTE.test(tag) || JAVASCRIPT_URL_ATTRIBUTE.test(tag)) return true;
    cursor = end + 1;
  }
  return false;
}

/**
 * SVG opens the document, or appears later as an element with its closing tag (or in truncated
 * text, where the close may lie beyond the window). Prose that names `<svg>` stays text.
 */
function hasSvgElement(markup: string, truncated: boolean): boolean {
  const element = /<svg(?:\s|>|\/)/u.exec(markup);
  if (element === null) return false;
  return element.index === 0 || truncated || markup.includes("</svg", element.index);
}

/** The root element after an optional non-HTML doctype and comments is not `html` or `svg`. */
function isNonHtmlXmlRoot(markup: string): boolean {
  let cursor = 0;
  if (markup.startsWith("<!doctype")) {
    if (/^<!doctype\s+(?:html|svg)\b/u.test(markup)) return false;
    let end = markup.indexOf(">");
    const subset = markup.indexOf("[");
    if (subset !== -1 && subset < end) {
      const close = markup.indexOf("]", subset);
      end = close === -1 ? -1 : markup.indexOf(">", close);
    }
    if (end === -1) return false;
    cursor = skipMarkupWhitespace(markup, end + 1);
  }
  while (markup.startsWith("<!--", cursor)) {
    const end = markup.indexOf("-->", cursor + 4);
    if (end === -1) return false;
    cursor = skipMarkupWhitespace(markup, end + 3);
  }
  const root = /^<([a-z_][a-z0-9_.-]*)(?::([a-z_][a-z0-9_.-]*))?(?:\s|>|\/)/u.exec(
    markup.slice(cursor, cursor + 256),
  );
  if (root === null) return false;
  const localName = root[2] ?? root[1];
  return localName !== "html" && localName !== "svg";
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a);
}

/** A PE image: "MZ" and an `e_lfanew` offset that points at a "PE\0\0" signature. */
function isPortableExecutable(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
  const offset = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0x3c,
    true,
  );
  return offset >= 2 && offset <= bytes.byteLength - 4 && ascii(bytes, offset, 4) === "PE\0\0";
}

/** An interpreter line names an absolute path: `#!/bin/sh` or `#! /usr/bin/env node`. */
function hasInterpreterLine(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return false;
  let offset = 2;
  while (bytes[offset] === 0x20 || bytes[offset] === 0x09) offset++;
  return bytes[offset] === 0x2f;
}

/** ID3v2 tag header: "ID3", a known major version, and a syncsafe size. */
function hasId3Header(bytes: Uint8Array): boolean {
  return (
    ascii(bytes, 0, 3) === "ID3" &&
    bytes.byteLength >= 10 &&
    bytes[3] >= 2 &&
    bytes[3] <= 4 &&
    bytes[4] !== 0xff &&
    bytes[6] < 0x80 &&
    bytes[7] < 0x80 &&
    bytes[8] < 0x80 &&
    bytes[9] < 0x80
  );
}

const MPEG_BITRATES_KBPS = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MPEG_SAMPLE_RATES = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
} as const;

/**
 * Length of the MPEG audio (layer I-III) frame whose header starts at `offset`, or undefined when
 * the four bytes there are not a valid header (reserved version or layer, free or invalid bitrate,
 * reserved sample rate, or reserved emphasis).
 */
function mpegAudioFrameLength(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.byteLength) return undefined;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  const bitrateIndex = b2 >> 4;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15) return undefined;
  if (sampleRateIndex === 3 || (bytes[offset + 3] & 0x03) === 2) return undefined;
  const mpeg1 = version === 3;
  const table =
    layer === 3
      ? mpeg1
        ? MPEG_BITRATES_KBPS.v1l1
        : MPEG_BITRATES_KBPS.v2l1
      : mpeg1
        ? layer === 2
          ? MPEG_BITRATES_KBPS.v1l2
          : MPEG_BITRATES_KBPS.v1l3
        : MPEG_BITRATES_KBPS.v2l23;
  const bitrate = table[bitrateIndex] * 1000;
  const sampleRate = MPEG_SAMPLE_RATES[version as 0 | 2 | 3][sampleRateIndex];
  if (layer === 3) return (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
  const coefficient = layer === 1 && !mpeg1 ? 72 : 144;
  return Math.floor((coefficient * bitrate) / sampleRate) + padding;
}

/**
 * MPEG audio without an ID3 tag must start with a valid frame header that is followed by
 * another valid header (or the end of the file) exactly one frame later, as in WHATWG mimesniff.
 * This keeps UTF-16LE text (`FF FE`) and other bytes that merely start with sync bits opaque.
 */
function isMpegAudioFrameSequence(bytes: Uint8Array): boolean {
  const length = mpegAudioFrameLength(bytes, 0);
  if (length === undefined) return false;
  return length === bytes.byteLength || mpegAudioFrameLength(bytes, length) !== undefined;
}

/** Header bytes of the first ADTS frame, or undefined when they are not a valid header. */
interface AdtsHeader {
  length: number;
  /** Fields that must stay the same in every frame of one stream. */
  fixed: number;
}

/**
 * Parse the ADTS header at `offset`: 12 sync bits, MPEG layer `00` (MP3 frames use the other
 * layers, so the two never overlap), a defined sampling frequency, and a frame length that
 * covers the header and at least one payload byte.
 */
function adtsHeader(bytes: Uint8Array, offset: number): AdtsHeader | undefined {
  if (offset + 7 > bytes.byteLength) return undefined;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (bytes[offset] !== 0xff || (b1 & 0xf6) !== 0xf0) return undefined;
  if (((b2 >> 2) & 0x0f) > 12) return undefined;
  const length = ((b3 & 0x03) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
  const headerLength = (b1 & 0x01) === 1 ? 7 : 9;
  if (length <= headerLength) return undefined;
  // ID, protection, profile, sampling frequency and channel configuration; not the private bit.
  return { length, fixed: (b1 << 16) | ((b2 & 0xfd) << 8) | (b3 & 0xc0) };
}

/**
 * AAC in ADTS framing must start with a valid header that is followed by another header with the
 * same fixed fields (or the end of the file) exactly one frame later, like MPEG audio above. This
 * keeps UTF-16LE text (`FF FE`) and other bytes that merely start with sync bits opaque.
 */
function isAdtsFrameSequence(bytes: Uint8Array): boolean {
  const first = adtsHeader(bytes, 0);
  if (first === undefined || first.length > bytes.byteLength) return false;
  if (first.length === bytes.byteLength) return true;
  return adtsHeader(bytes, first.length)?.fixed === first.fixed;
}

/** TIFF field types 1-12 from TIFF 6.0 and 13 (IFD) from the TIFF/EP and DNG extensions. */
const TIFF_MAX_FIELD_TYPE = 13;

/**
 * Classic TIFF in either byte order: `II*\0` or `MM\0*`, then a first IFD at an even offset past
 * the header whose entries, field types and next-IFD offset all fit inside the file.
 */
function isTiff(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false;
  const little = ascii(bytes, 0, 4) === "II*\0";
  if (!little && ascii(bytes, 0, 4) !== "MM\0*") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd < 8 || ifd % 2 !== 0 || ifd + 2 > bytes.byteLength) return false;
  const entries = view.getUint16(ifd, little);
  if (entries === 0 || ifd + 2 + entries * 12 + 4 > bytes.byteLength) return false;
  for (let index = 0; index < entries; index++) {
    const type = view.getUint16(ifd + 2 + index * 12 + 2, little);
    if (type === 0 || type > TIFF_MAX_FIELD_TYPE) return false;
  }
  return true;
}

const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_DOC_TYPE_ID = 0x4282;
/** Registered DocTypes are short words such as `webm` and `matroska`. */
const EBML_DOC_TYPE_MAX_BYTES = 64;

/**
 * Read an EBML variable-length integer at `offset`. Element IDs keep their length marker and are
 * at most four bytes; sizes drop it, may use eight bytes, and must not be the reserved
 * "unknown size" value (all value bits set).
 */
function ebmlVint(
  bytes: Uint8Array,
  offset: number,
  end: number,
  kind: "id" | "size",
): { value: number; next: number } | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  const length = Math.clz32(first) - 23;
  if ((kind === "id" && length > 4) || offset + length > end) return undefined;
  const mask = 0xff >> length;
  let value = kind === "id" ? first : first & mask;
  let unknown = (first & mask) === mask;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index];
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  if (kind === "size" && unknown) return undefined;
  return { value, next: offset + length };
}

/**
 * DocType of a complete EBML header (`1A 45 DF A3`): the header and every child element must fit
 * inside the file, and the header must name exactly one printable ASCII DocType. WebM and
 * Matroska share the container, so only the DocType tells them apart.
 */
function ebmlDocType(bytes: Uint8Array): string | undefined {
  const header = ebmlVint(bytes, 0, bytes.byteLength, "id");
  if (header?.value !== EBML_HEADER_ID) return undefined;
  const size = ebmlVint(bytes, header.next, bytes.byteLength, "size");
  if (size === undefined || size.next + size.value > bytes.byteLength) return undefined;
  const end = size.next + size.value;
  let docType: string | undefined;
  let cursor = size.next;
  while (cursor < end) {
    const id = ebmlVint(bytes, cursor, end, "id");
    if (id === undefined) return undefined;
    const length = ebmlVint(bytes, id.next, end, "size");
    if (length === undefined || length.next + length.value > end) return undefined;
    if (id.value === EBML_DOC_TYPE_ID) {
      if (docType !== undefined || length.value > EBML_DOC_TYPE_MAX_BYTES) return undefined;
      // Strings may be padded with trailing NUL bytes.
      docType = ascii(bytes, length.next, length.value).replace(/\0+$/u, "");
      if (!/^[\x21-\x7e]+$/u.test(docType)) return undefined;
    }
    cursor = length.next + length.value;
  }
  return docType;
}

const BMP_DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

/** BMP needs a known DIB header size and a pixel offset past the headers, not just "BM". */
function isBmp(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 2) !== "BM" || bytes.byteLength < 26) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = view.getUint32(10, true);
  const dibHeaderSize = view.getUint32(14, true);
  return (
    BMP_DIB_HEADER_SIZES.has(dibHeaderSize) &&
    pixelOffset >= 14 + dibHeaderSize &&
    pixelOffset <= bytes.byteLength
  );
}

const ISO_BMFF_BRANDS: ReadonlyMap<string, string> = new Map([
  ["avif", "image/avif"],
  ["avis", "image/avif"],
  ["heic", "image/heic"],
  ["heix", "image/heic"],
  ["heim", "image/heic"],
  ["heis", "image/heic"],
  ["hevc", "image/heic-sequence"],
  ["hevx", "image/heic-sequence"],
  ["mif1", "image/heif"],
  ["msf1", "image/heif-sequence"],
  ["M4A ", "audio/mp4"],
  ["M4B ", "audio/mp4"],
  ["M4P ", "audio/mp4"],
  ["F4A ", "audio/mp4"],
  ["F4B ", "audio/mp4"],
  ["qt  ", "video/quicktime"],
  ["3gp4", "video/3gpp"],
  ["3gp5", "video/3gpp"],
  ["3gp6", "video/3gpp"],
  ["3gp7", "video/3gpp"],
  ["3gg6", "video/3gpp"],
  ["3g2a", "video/3gpp2"],
  ["3g2b", "video/3gpp2"],
  ["3g2c", "video/3gpp2"],
  ["isom", "video/mp4"],
  ["iso2", "video/mp4"],
  ["iso3", "video/mp4"],
  ["iso4", "video/mp4"],
  ["iso5", "video/mp4"],
  ["iso6", "video/mp4"],
  ["mp41", "video/mp4"],
  ["mp42", "video/mp4"],
  ["avc1", "video/mp4"],
  ["dash", "video/mp4"],
  ["M4V ", "video/mp4"],
  ["M4VH", "video/mp4"],
  ["M4VP", "video/mp4"],
  ["f4v ", "video/mp4"],
  ["mmp4", "video/mp4"],
  ["MSNV", "video/mp4"],
]);

/** Structural brands that say little about the payload; a specific compatible brand wins. */
const GENERIC_ISO_BMFF_BRANDS = new Set([
  "mif1",
  "msf1",
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "dash",
]);

/**
 * Classify an ISO base media file (`ftyp` box) by its brands: the first specific brand among the
 * major and compatible brands, else the first generic one. Malformed boxes and unknown brands fall
 * through to the remaining signatures instead of defaulting to MP4 video.
 */
function sniffIsoBaseMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 16 || ascii(bytes, 4, 4) !== "ftyp") return undefined;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (boxSize < 16 || boxSize % 4 !== 0 || boxSize > bytes.byteLength) return undefined;
  // Offset 8 holds the major brand, 12 the minor version, and compatible brands follow.
  const brands = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(bytes, offset, 4));
  const known = brands.filter((brand) => ISO_BMFF_BRANDS.has(brand));
  const brand = known.find((value) => !GENERIC_ISO_BMFF_BRANDS.has(value)) ?? known[0];
  return brand === undefined ? undefined : ISO_BMFF_BRANDS.get(brand);
}

function trailingUtf8Completion(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  const start = trailingUtf8SequenceStart(bytes);
  const lead = bytes[start];
  const width =
    lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
        ? 3
        : lead >= 0xf0 && lead <= 0xf4
          ? 4
          : 1;
  const present = bytes.byteLength - start;
  return width > present ? width - present : 0;
}

function trailingUtf8SequenceStart(bytes: Uint8Array): number {
  let start = bytes.byteLength - 1;
  while (start > 0 && bytes[start] >= 0x80 && bytes[start] <= 0xbf) start--;
  return start;
}

function skipMarkupWhitespace(value: string, start: number): number {
  let cursor = start;
  while (/\s/u.test(value[cursor] ?? "")) cursor++;
  return cursor;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}
